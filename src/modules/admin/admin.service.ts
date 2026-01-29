import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UserRole, UserStatus, OrderStatus, SellerType } from '@prisma/client';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // ============ USER MANAGEMENT ============

  async getAllUsers(params: {
    page?: number;
    limit?: number;
    role?: UserRole;
    status?: UserStatus;
    sellerType?: SellerType;
    search?: string;
  }) {
    const { page = 1, limit = 10, role, status, sellerType, search } = params;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (role) where.role = role;
    if (status) where.status = status;
    if (sellerType) where.sellerType = sellerType;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          sellerType: true,
          cnpj: true,
          legalCompanyName: true,
          mercadoPagoConnected: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              orders: true,
              products: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        sellerType: true,
        cnpj: true,
        legalCompanyName: true,
        mercadoPagoConnected: true,
        mercadoPagoAccountId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            orders: true,
            products: true,
            addresses: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateUserRole(id: string, role: UserRole) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.user.update({
      where: { id },
      data: { role },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        sellerType: true,
      },
    });
  }

  async updateUserStatus(id: string, status: UserStatus) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.ADMIN) {
      throw new BadRequestException('Cannot change status of admin users');
    }

    return this.prisma.user.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        sellerType: true,
        mercadoPagoConnected: true,
      },
    });
  }

  async updateBusinessInfo(id: string, data: { cnpj?: string; legalCompanyName?: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role !== UserRole.SELLER) {
      throw new BadRequestException('Can only update business info for seller accounts');
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        cnpj: data.cnpj,
        legalCompanyName: data.legalCompanyName,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        sellerType: true,
        cnpj: true,
        legalCompanyName: true,
        mercadoPagoConnected: true,
      },
    });
  }

  // ============ ORDER OVERSIGHT ============

  async getAllOrders(params: {
    page?: number;
    limit?: number;
    status?: OrderStatus;
    startDate?: string;
    endDate?: string;
  }) {
    const { page = 1, limit = 10, status, startDate, endDate } = params;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
          items: {
            include: {
              product: {
                select: { id: true, name: true, sku: true },
              },
            },
          },
          address: true,
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async updateOrderStatus(orderId: string, status: OrderStatus) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: {
        user: { select: { id: true, name: true, email: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
          },
        },
        address: true,
      },
    });
  }

  // ============ DASHBOARD STATS ============

  async getDashboardStats() {
    const [
      totalUsers,
      totalProducts,
      totalOrders,
      revenueResult,
      usersByRole,
      ordersByStatus,
      recentOrders,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.product.count(),
      this.prisma.order.count(),
      this.prisma.order.aggregate({
        where: {
          status: { in: [OrderStatus.PAID, OrderStatus.SHIPPED, OrderStatus.DELIVERED] },
        },
        _sum: { total: true },
      }),
      this.prisma.user.groupBy({
        by: ['role'],
        _count: { role: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { status: true },
      }),
      this.prisma.order.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { name: true, email: true } },
        },
      }),
    ]);

    const revenue = revenueResult._sum.total?.toNumber() || 0;

    return {
      summary: {
        totalUsers,
        totalProducts,
        totalOrders,
        revenue,
      },
      usersByRole: usersByRole.reduce((acc, item) => {
        acc[item.role] = item._count.role;
        return acc;
      }, {} as Record<string, number>),
      ordersByStatus: ordersByStatus.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {} as Record<string, number>),
      recentOrders,
    };
  }

  // ============ PRODUCT MANAGEMENT ============

  async getAllProducts() {
    // Only show products that have been submitted for approval
    // This excludes drafts from PENDING sellers
    return this.prisma.product.findMany({
      where: {
        isSubmittedForApproval: true,
      },
      include: {
        category: true,
        seller: { select: { id: true, name: true, email: true, status: true, sellerType: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateProductStatus(productId: string, status: 'PENDING' | 'APPROVED' | 'CANCELLED') {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return this.prisma.product.update({
      where: { id: productId },
      data: { status },
      include: {
        category: true,
        seller: { select: { id: true, name: true, email: true } },
      },
    });
  }
}
