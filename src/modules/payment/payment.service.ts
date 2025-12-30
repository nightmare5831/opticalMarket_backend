import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentStatus } from '@prisma/client';
import axios from 'axios';

interface CreateCheckoutData {
  orderId: string;
  payerEmail: string;
}

@Injectable()
export class PaymentService {
  private accessToken: string;
  private baseUrl = 'https://api.mercadopago.com';

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private ordersService: OrdersService,
  ) {
    this.accessToken =
      this.configService.get<string>('MERCADO_PAGO_ACCESS_TOKEN') || '';
  }

  async createCheckout(userId: string, data: CreateCheckoutData) {
    const { orderId, payerEmail } = data;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!order) {
      throw new BadRequestException('Order not found');
    }

    if (order.paymentStatus === PaymentStatus.APPROVED) {
      throw new BadRequestException('Order already paid');
    }

    const frontendUrl = this.configService.get('FRONTEND_URL');

    // Build items for Checkout Pro
    const items = order.items.map((item) => ({
      id: item.productId,
      title: item.product.name,
      quantity: item.quantity,
      unit_price: Number(item.price),
      currency_id: 'BRL',
    }));

    // Only allow PIX and Credit Card
    const preferenceData: any = {
      items,
      payer: {
        email: payerEmail,
      },
      external_reference: order.id,
      notification_url: `${this.configService.get('API_URL')}/api/payment/webhook`,
      statement_descriptor: 'OPTICAL MARKET',
      payment_methods: {
        excluded_payment_types: [
          { id: 'debit_card' },
          { id: 'ticket' },
          { id: 'atm' },
          { id: 'prepaid_card' },
        ],
        installments: 12,
      },
    };

    // Only add back_urls if frontend URL is properly configured (not localhost for sandbox)
    if (frontendUrl && !frontendUrl.includes('localhost')) {
      preferenceData.back_urls = {
        success: `${frontendUrl}/checkout/confirmation?orderId=${order.id}`,
        failure: `${frontendUrl}/checkout/payment?orderId=${order.id}&status=failure`,
        pending: `${frontendUrl}/checkout/payment?orderId=${order.id}&status=pending`,
      };
      preferenceData.auto_return = 'approved';
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/checkout/preferences`,
        preferenceData,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const preference = response.data;

      return {
        preferenceId: preference.id,
        initPoint: preference.init_point, // Production URL
        sandboxInitPoint: preference.sandbox_init_point, // Sandbox URL for testing
      };
    } catch (error: any) {
      console.error(
        'Mercado Pago error:',
        error.response?.data || error.message,
      );
      throw new BadRequestException(
        error.response?.data?.message || 'Failed to create checkout session',
      );
    }
  }

  async handleWebhook(data: any) {
    if (data.type !== 'payment') {
      return { received: true };
    }

    const paymentId = data.data?.id;
    if (!paymentId) {
      return { received: true };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/v1/payments/${paymentId}`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        },
      );

      const payment = response.data;
      const orderId = payment.external_reference;

      if (orderId) {
        await this.ordersService.updatePaymentStatus(
          orderId,
          String(payment.id),
          this.mapPaymentStatus(payment.status),
        );
      }

      return { received: true, processed: true };
    } catch (error: any) {
      console.error('Webhook processing error:', error.message);
      return { received: true, error: error.message };
    }
  }

  async getPaymentStatus(orderId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: {
        id: true,
        paymentId: true,
        paymentStatus: true,
        paymentMethod: true,
        status: true,
      },
    });

    if (!order) {
      throw new BadRequestException('Order not found');
    }

    if (!order.paymentId) {
      return {
        orderId: order.id,
        paymentStatus: order.paymentStatus,
        orderStatus: order.status,
      };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/v1/payments/${order.paymentId}`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        },
      );

      const payment = response.data;

      const currentStatus = this.mapPaymentStatus(payment.status);
      if (currentStatus !== order.paymentStatus) {
        await this.ordersService.updatePaymentStatus(
          orderId,
          String(payment.id),
          currentStatus,
        );
      }

      return {
        orderId: order.id,
        paymentId: order.paymentId,
        paymentStatus: currentStatus,
        orderStatus: order.status,
        paymentMethod: order.paymentMethod,
        statusDetail: payment.status_detail,
      };
    } catch (error: any) {
      console.error('Payment status check error:', error.message);
      return {
        orderId: order.id,
        paymentStatus: order.paymentStatus,
        orderStatus: order.status,
      };
    }
  }

  private mapPaymentStatus(mpStatus: string): PaymentStatus {
    const statusMap: Record<string, PaymentStatus> = {
      pending: PaymentStatus.PENDING,
      approved: PaymentStatus.APPROVED,
      authorized: PaymentStatus.APPROVED,
      in_process: PaymentStatus.IN_PROCESS,
      in_mediation: PaymentStatus.IN_PROCESS,
      rejected: PaymentStatus.REJECTED,
      cancelled: PaymentStatus.CANCELLED,
      refunded: PaymentStatus.CANCELLED,
      charged_back: PaymentStatus.CANCELLED,
    };
    return statusMap[mpStatus] || PaymentStatus.PENDING;
  }
}
