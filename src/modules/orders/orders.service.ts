import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentMethod, PaymentStatus, OrderStatus, ShippingType } from '@prisma/client';
import { BlingService } from '../bling/bling.service';

interface CartItem {
  productId: string;
  quantity: number;
}

interface CreateOrderData {
  addressId: string;
  items: CartItem[];
  paymentMethod: PaymentMethod;
  shippingType: ShippingType;
  shippingMethod?: string;
  shippingCost?: number;
}

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private blingService: BlingService,
  ) {}

  async findAll(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, images: true, sku: true, seller: { select: { name: true } } },
            },
          },
        },
        address: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, userId },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, images: true, sku: true },
            },
          },
        },
        address: true,
      },
    });

    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async create(userId: string, data: CreateOrderData) {
    const { addressId, items, paymentMethod } = data;

    if (!items || items.length === 0) throw new BadRequestException('Cart is empty');

    const address = await this.prisma.address.findFirst({ where: { id: addressId, userId } });
    if (!address) throw new NotFoundException('Address not found');

    const productIds = items.map((item) => item.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    if (products.length !== items.length) throw new BadRequestException('One or more products not found');

    // Validate stock
    for (const item of items) {
      const product = products.find((p) => p.id === item.productId);
      if (product && product.stock < item.quantity) {
        throw new BadRequestException(`Insufficient stock for product: ${product.name}`);
      }
    }

    // Group items by seller
    const sellerGroups = new Map<string, { productId: string; quantity: number; price: number }[]>();
    for (const item of items) {
      const product = products.find((p) => p.id === item.productId)!;
      const sellerId = product.sellerId || 'platform';
      if (!sellerGroups.has(sellerId)) sellerGroups.set(sellerId, []);
      sellerGroups.get(sellerId)!.push({
        productId: item.productId,
        quantity: item.quantity,
        price: Number(product.price),
      });
    }

    // Split shipping evenly across seller orders (0 for seller shipping)
    const sellerCount = sellerGroups.size;
    const shippingCost = data.shippingType === ShippingType.SELLER ? 0 : (data.shippingCost || 0);
    const shippingPerSeller = shippingCost / sellerCount;

    // Create one order per seller in a transaction
    const orders = await this.prisma.$transaction(async (tx) => {
      const createdOrders: any[] = [];

      for (const [sellerId, sellerItems] of sellerGroups) {
        const itemsTotal = sellerItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
        const total = itemsTotal + shippingPerSeller;

        const order = await tx.order.create({
          data: {
            userId,
            sellerId: sellerId === 'platform' ? null : sellerId,
            addressId,
            paymentMethod,
            shippingMethod: data.shippingMethod || null,
            shippingType: data.shippingType,
            total,
            status: OrderStatus.PENDING,
            paymentStatus: PaymentStatus.PENDING,
            items: {
              create: sellerItems.map((i) => ({
                productId: i.productId,
                quantity: i.quantity,
                price: i.price,
              })),
            },
          },
          include: {
            items: {
              include: {
                product: { select: { id: true, name: true, images: true, sku: true } },
              },
            },
            address: true,
          },
        });

        // Decrement stock
        for (const item of sellerItems) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { decrement: item.quantity } },
          });
        }

        createdOrders.push(order);
      }

      return createdOrders;
    });

    // Return array if multi-seller, single order if single seller
    return orders.length === 1 ? orders[0] : orders;
  }

  async updatePaymentStatus(orderId: string, paymentId: string, status: PaymentStatus) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    const updateData: any = { paymentId, paymentStatus: status };

    if (status === PaymentStatus.APPROVED) {
      updateData.status = OrderStatus.PAID;
    } else if (status === PaymentStatus.REJECTED || status === PaymentStatus.CANCELLED) {
      updateData.status = OrderStatus.CANCELLED;

      const orderItems = await this.prisma.orderItem.findMany({ where: { orderId } });
      for (const item of orderItems) {
        await this.prisma.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      }
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: {
        items: { include: { product: { select: { id: true, name: true, images: true, sku: true } } } },
        address: true,
      },
    });
  }

  async findSellerOrders(sellerId: string) {
    return this.prisma.order.findMany({
      where: { sellerId },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, images: true, sku: true } },
          },
        },
        address: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateOrderStatus(orderId: string, sellerId: string, newStatus: OrderStatus) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, sellerId },
    });

    if (!order) throw new NotFoundException('Order not found or not authorized');

    const validTransitions: Record<OrderStatus, OrderStatus[]> = {
      [OrderStatus.PENDING]: [OrderStatus.CANCELLED],
      [OrderStatus.PAID]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
      [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
      [OrderStatus.DELIVERED]: [],
      [OrderStatus.CANCELLED]: [],
    };

    if (!validTransitions[order.status].includes(newStatus)) {
      throw new BadRequestException(`Cannot transition from ${order.status} to ${newStatus}`);
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: newStatus },
      include: {
        items: { include: { product: { select: { id: true, name: true, images: true, sku: true } } } },
        address: true,
      },
    });
  }

  async createBlingOrder(orderId: string, sellerId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, sellerId },
      include: {
        items: { include: { product: true } },
        address: true,
        user: { select: { name: true, email: true } },
      },
    });

    if (!order) throw new NotFoundException('Order not found');
    if (!order.address) throw new BadRequestException('Order has no shipping address');
    if (!order.user.name) throw new BadRequestException('Customer name is required for Bling sync');
    if (!order.user.email) throw new BadRequestException('Customer email is required for Bling sync');

    const itemsWithoutSku = order.items.filter(item => !item.product.sku);
    if (itemsWithoutSku.length > 0) {
      throw new BadRequestException(`Products missing SKU: ${itemsWithoutSku.map(i => i.product.name).join(', ')}`);
    }

    if (!order.address.street || !order.address.number || !order.address.neighborhood ||
        !order.address.city || !order.address.state || !order.address.zipCode) {
      throw new BadRequestException('Address is incomplete');
    }

    return this.blingService.createOrderInBling(sellerId, {
      orderNumber: order.id.slice(0, 8).toUpperCase(),
      customer: { name: order.user.name, email: order.user.email },
      address: {
        street: order.address.street,
        number: order.address.number,
        complement: order.address.complement || undefined,
        neighborhood: order.address.neighborhood,
        city: order.address.city,
        state: order.address.state,
        zipCode: order.address.zipCode,
      },
      items: order.items.map((item) => ({
        sku: item.product.sku,
        name: item.product.name,
        quantity: item.quantity,
        price: Number(item.price),
        blingId: item.product.blingId,
      })),
      total: Number(order.total),
      paymentMethod: order.paymentMethod || 'N/A',
    });
  }
}
