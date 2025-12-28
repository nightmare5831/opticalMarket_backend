import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentStatus, PaymentMethod } from '@prisma/client';
import axios from 'axios';

interface CreatePaymentData {
  orderId: string;
  paymentMethod: PaymentMethod;
  cardToken?: string;
  installments?: number;
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

  async createPayment(userId: string, data: CreatePaymentData) {
    const { orderId, paymentMethod, cardToken, installments, payerEmail } =
      data;

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

    const paymentData: any = {
      transaction_amount: Number(order.total),
      description: `Order #${order.id.slice(0, 8)}`,
      external_reference: order.id,
      payer: {
        email: payerEmail,
      },
      notification_url: `${this.configService.get('API_URL')}/api/payment/webhook`,
    };

    if (paymentMethod === PaymentMethod.PIX) {
      paymentData.payment_method_id = 'pix';
    } else if (paymentMethod === PaymentMethod.CREDIT_CARD) {
      if (!cardToken) {
        throw new BadRequestException(
          'Card token is required for credit card payment',
        );
      }
      paymentData.token = cardToken;
      paymentData.installments = installments || 1;
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/v1/payments`,
        paymentData,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': `${order.id}-${Date.now()}`,
          },
        },
      );

      const payment = response.data;

      await this.ordersService.updatePaymentStatus(
        orderId,
        String(payment.id),
        this.mapPaymentStatus(payment.status),
      );

      return {
        paymentId: payment.id,
        status: payment.status,
        statusDetail: payment.status_detail,
        pixQrCode: payment.point_of_interaction?.transaction_data?.qr_code,
        pixQrCodeBase64:
          payment.point_of_interaction?.transaction_data?.qr_code_base64,
        ticketUrl: payment.point_of_interaction?.transaction_data?.ticket_url,
      };
    } catch (error: any) {
      console.error(
        'Mercado Pago error:',
        error.response?.data || error.message,
      );
      throw new BadRequestException(
        error.response?.data?.message || 'Payment processing failed',
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
        total: true,
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
