import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { SellerSettingsService } from '../seller-settings/seller-settings.service';
import { PaymentStatus } from '@prisma/client';
import axios from 'axios';

interface CreateCheckoutData {
  orderId: string;
  payerEmail: string;
}

// Fee rates
const CREDIT_CARD_FEE = 0.10; // 10%
const PIX_FEE = 0.08; // 8%

@Injectable()
export class PaymentService {
  private platformToken: string;
  private baseUrl = 'https://api.mercadopago.com';

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private ordersService: OrdersService,
    private sellerSettingsService: SellerSettingsService,
  ) {
    this.platformToken = this.configService.get<string>('MERCADO_PAGO_ACCESS_TOKEN') || '';
  }

  async validateSellersMpConnection(productIds: string[]) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        sellerId: true,
        seller: {
          select: { id: true, name: true, mercadoPagoConnected: true },
        },
      },
    });

    const disconnectedSellers: { sellerName: string; productNames: string[] }[] = [];
    const sellerMap = new Map<string, { name: string; connected: boolean; products: string[] }>();

    for (const product of products) {
      if (!product.sellerId || !product.seller) continue;
      const existing = sellerMap.get(product.sellerId);
      if (existing) {
        existing.products.push(product.name);
      } else {
        sellerMap.set(product.sellerId, {
          name: product.seller.name,
          connected: product.seller.mercadoPagoConnected,
          products: [product.name],
        });
      }
    }

    for (const [, seller] of sellerMap) {
      if (!seller.connected) {
        disconnectedSellers.push({ sellerName: seller.name, productNames: seller.products });
      }
    }

    return {
      valid: disconnectedSellers.length === 0,
      disconnectedSellers,
    };
  }

  async createCheckout(userId: string, data: CreateCheckoutData) {
    const { orderId, payerEmail } = data;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { items: { include: { product: { include: { seller: true } } } } },
    });

    if (!order) throw new BadRequestException('Order not found');
    if (order.paymentStatus === PaymentStatus.APPROVED) throw new BadRequestException('Order already paid');

    // Get the seller for this order
    const sellerId = order.sellerId;
    let sellerToken: string | null = null;

    if (sellerId) {
      const seller = await this.prisma.user.findUnique({
        where: { id: sellerId },
        select: { mercadoPagoAccessToken: true, mercadoPagoConnected: true },
      });

      if (seller?.mercadoPagoConnected && seller.mercadoPagoAccessToken) {
        sellerToken = seller.mercadoPagoAccessToken;
      }
    }

    // Use seller's token for destination charge, fallback to platform token
    const accessToken = sellerToken || this.platformToken;

    const frontendUrl = this.configService.get('FRONTEND_URL');

    const items = order.items.map((item) => ({
      id: item.productId,
      title: item.product.name,
      quantity: item.quantity,
      unit_price: Number(item.price),
      currency_id: 'BRL',
    }));

    // Add shipping as item if applicable
    const itemsTotal = order.items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
    const shippingCost = Number(order.total) - itemsTotal;
    if (shippingCost > 0) {
      items.push({
        id: 'shipping',
        title: `Shipping (${order.shippingMethod || 'Standard'})`,
        quantity: 1,
        unit_price: shippingCost,
        currency_id: 'BRL',
      });
    }

    // Calculate application fee (platform commission)
    const feeRate = order.paymentMethod === 'PIX' ? PIX_FEE : CREDIT_CARD_FEE;
    const applicationFee = sellerToken ? Math.round(Number(order.total) * feeRate * 100) / 100 : 0;

    const preferenceData: any = {
      items,
      payer: { email: payerEmail },
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

    // Add application fee for marketplace split (only when using seller token)
    if (sellerToken && applicationFee > 0) {
      preferenceData.marketplace_fee = applicationFee;
    }

    if (frontendUrl && !frontendUrl.includes('localhost')) {
      preferenceData.back_urls = {
        success: `${frontendUrl}/buyer/orders?confirmed`,
        failure: `${frontendUrl}/buyer/orders?confirmed&status=failure`,
        pending: `${frontendUrl}/buyer/orders?confirmed&status=pending`,
      };
      preferenceData.auto_return = 'approved';
    }

    try {
      const response = await axios.post(`${this.baseUrl}/checkout/preferences`, preferenceData, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });

      // Save application fee to order
      if (applicationFee > 0) {
        await this.prisma.order.update({
          where: { id: orderId },
          data: { applicationFee },
        });
      }

      return {
        preferenceId: response.data.id,
        initPoint: response.data.init_point,
        sandboxInitPoint: response.data.sandbox_init_point,
      };
    } catch (error: any) {
      // If seller token failed, try refreshing it
      if (sellerToken && sellerId && error.response?.status === 401) {
        const newToken = await this.sellerSettingsService.refreshSellerToken(sellerId);
        if (newToken) {
          const retryResponse = await axios.post(`${this.baseUrl}/checkout/preferences`, preferenceData, {
            headers: { Authorization: `Bearer ${newToken}`, 'Content-Type': 'application/json' },
          });
          return {
            preferenceId: retryResponse.data.id,
            initPoint: retryResponse.data.init_point,
            sandboxInitPoint: retryResponse.data.sandbox_init_point,
          };
        }
      }
      console.error('Mercado Pago error:', error.response?.data || error.message);
      throw new BadRequestException(error.response?.data?.message || 'Failed to create checkout session');
    }
  }

  async handleWebhook(data: any) {
    if (data.type !== 'payment') return { received: true };

    const paymentId = data.data?.id;
    if (!paymentId) return { received: true };

    try {
      // Try platform token first to get payment info
      const response = await axios.get(`${this.baseUrl}/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${this.platformToken}` },
      }).catch(() => null);

      // If platform token fails, find the order and use seller token
      let payment = response?.data;
      if (!payment) {
        const order = await this.prisma.order.findFirst({
          where: { paymentId: String(paymentId) },
          select: { sellerId: true },
        });
        if (order?.sellerId) {
          const seller = await this.prisma.user.findUnique({
            where: { id: order.sellerId },
            select: { mercadoPagoAccessToken: true },
          });
          if (seller?.mercadoPagoAccessToken) {
            const sellerResponse = await axios.get(`${this.baseUrl}/v1/payments/${paymentId}`, {
              headers: { Authorization: `Bearer ${seller.mercadoPagoAccessToken}` },
            });
            payment = sellerResponse.data;
          }
        }
      }

      if (payment?.external_reference) {
        await this.ordersService.updatePaymentStatus(
          payment.external_reference,
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
      select: { id: true, paymentId: true, paymentStatus: true, paymentMethod: true, status: true, sellerId: true },
    });

    if (!order) throw new BadRequestException('Order not found');
    if (!order.paymentId) {
      return { orderId: order.id, paymentStatus: order.paymentStatus, orderStatus: order.status };
    }

    try {
      // Use seller token if available, fallback to platform
      let accessToken = this.platformToken;
      if (order.sellerId) {
        const seller = await this.prisma.user.findUnique({
          where: { id: order.sellerId },
          select: { mercadoPagoAccessToken: true },
        });
        if (seller?.mercadoPagoAccessToken) accessToken = seller.mercadoPagoAccessToken;
      }

      const response = await axios.get(`${this.baseUrl}/v1/payments/${order.paymentId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const currentStatus = this.mapPaymentStatus(response.data.status);
      if (currentStatus !== order.paymentStatus) {
        await this.ordersService.updatePaymentStatus(orderId, String(response.data.id), currentStatus);
      }

      return {
        orderId: order.id,
        paymentId: order.paymentId,
        paymentStatus: currentStatus,
        orderStatus: order.status,
        paymentMethod: order.paymentMethod,
        statusDetail: response.data.status_detail,
      };
    } catch {
      return { orderId: order.id, paymentStatus: order.paymentStatus, orderStatus: order.status };
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
