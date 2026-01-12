import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentMethod, PaymentStatus, OrderStatus } from '@prisma/client';
import { BlingService } from '../bling/bling.service';

interface CartItem {
  productId: string;
  quantity: number;
}

interface CreateOrderData {
  addressId: string;
  items: CartItem[];
  paymentMethod: PaymentMethod;
  shippingMethod?: string;
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
              select: { id: true, name: true, images: true, sku: true },
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

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  async create(userId: string, data: CreateOrderData) {
    const { addressId, items, paymentMethod } = data;

    if (!items || items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId },
    });

    if (!address) {
      throw new NotFoundException('Address not found');
    }

    const productIds = items.map((item) => item.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    if (products.length !== items.length) {
      throw new BadRequestException('One or more products not found');
    }

    for (const item of items) {
      const product = products.find((p) => p.id === item.productId);
      if (product && product.stock < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for product: ${product.name}`,
        );
      }
    }

    let total = 0;
    const orderItems = items.map((item) => {
      const product = products.find((p) => p.id === item.productId)!;
      const itemTotal = Number(product.price) * item.quantity;
      total += itemTotal;
      return {
        productId: item.productId,
        quantity: item.quantity,
        price: product.price,
      };
    });

    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId,
          addressId,
          paymentMethod,
          shippingMethod: data.shippingMethod,
          total,
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          items: {
            create: orderItems,
          },
        },
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

      for (const item of items) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stock: {
              decrement: item.quantity,
            },
          },
        });
      }

      return newOrder;
    });

    return order;
  }

  async updatePaymentStatus(
    orderId: string,
    paymentId: string,
    status: PaymentStatus,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const updateData: any = {
      paymentId,
      paymentStatus: status,
    };

    if (status === PaymentStatus.APPROVED) {
      updateData.status = OrderStatus.PAID;
    } else if (
      status === PaymentStatus.REJECTED ||
      status === PaymentStatus.CANCELLED
    ) {
      updateData.status = OrderStatus.CANCELLED;

      const orderItems = await this.prisma.orderItem.findMany({
        where: { orderId },
      });

      for (const item of orderItems) {
        await this.prisma.product.update({
          where: { id: item.productId },
          data: {
            stock: {
              increment: item.quantity,
            },
          },
        });
      }
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
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
  }

  async findByPaymentId(paymentId: string) {
    return this.prisma.order.findFirst({
      where: { paymentId },
    });
  }

  async findSellerOrders(sellerId: string) {
    return this.prisma.order.findMany({
      where: {
        items: {
          some: {
            product: {
              sellerId: sellerId,
            },
          },
        },
      },
      include: {
        items: {
          where: {
            product: {
              sellerId: sellerId,
            },
          },
          include: {
            product: {
              select: { id: true, name: true, images: true, sku: true },
            },
          },
        },
        address: true,
        user: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateOrderStatus(
    orderId: string,
    sellerId: string,
    newStatus: OrderStatus,
  ) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        items: {
          some: {
            product: {
              sellerId: sellerId,
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found or not authorized');
    }

    const validTransitions: Record<OrderStatus, OrderStatus[]> = {
      [OrderStatus.PENDING]: [OrderStatus.CANCELLED],
      [OrderStatus.PAID]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
      [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
      [OrderStatus.DELIVERED]: [],
      [OrderStatus.CANCELLED]: [],
    };

    if (!validTransitions[order.status].includes(newStatus)) {
      throw new BadRequestException(
        `Cannot transition from ${order.status} to ${newStatus}`,
      );
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: newStatus },
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
  }

  async createBlingOrder(orderId: string, sellerId: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        items: {
          some: {
            product: {
              sellerId: sellerId,
            },
          },
        },
      },
      include: {
        items: {
          include: {
            product: true,
          },
        },
        address: true,
        user: {
          select: { name: true, email: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (!order.address) {
      throw new BadRequestException('Order has no shipping address');
    }

    const orderNumber = order.id.slice(0, 8).toUpperCase();

    const result = await this.blingService.createOrderInBling(sellerId, {
      orderNumber,
      customer: {
        name: order.user.name,
        email: order.user.email,
      },
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
      })),
      total: Number(order.total),
      paymentMethod: order.paymentMethod || 'N/A',
    });

    return result;
  }
}
