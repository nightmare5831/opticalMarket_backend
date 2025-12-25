import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlingService } from '../bling/bling.service';

@Injectable()
export class CategoriesService {
  constructor(
    private prisma: PrismaService,
    private blingService: BlingService,
  ) {}

  async findAll(userId?: string, userRole?: string) {
    // If user is ADMIN or SELLER, return only their categories
    // If user is CUSTOMER or not authenticated, return all categories
    const where = (userId && (userRole === 'ADMIN' || userRole === 'SELLER'))
      ? { userId }
      : {};

    return this.prisma.category.findMany({
      where,
      include: {
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, userId: string) {
    return this.prisma.category.findFirst({
      where: { id, userId },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });
  }

  async create(data: { name: string; slug: string }, userId: string) {
    let blingId: number | undefined;

    // If Bling is connected, create in Bling first
    const isBlingConnected = await this.blingService.isConfigured(userId);

    if (isBlingConnected) {
      const blingResult = await this.blingService.createCategoryInBling(userId, data.name);

      if (!blingResult.success) {
        throw new Error(blingResult.error || 'Failed to create category in Bling');
      }

      blingId = blingResult.blingId;
    }

    // Then save to local database with Bling ID and userId
    return this.prisma.category.create({
      data: {
        ...data,
        blingId,
        userId,
      },
    });
  }

  async update(id: string, data: Partial<{ name: string; slug: string }>, userId: string) {
    // First check if category belongs to user
    const category = await this.prisma.category.findFirst({
      where: { id, userId },
    });

    if (!category) {
      throw new Error('Category not found or you do not have permission to update it');
    }

    return this.prisma.category.update({
      where: { id },
      data,
    });
  }

  async delete(id: string, userId: string) {
    // First check if category belongs to user
    const category = await this.prisma.category.findFirst({
      where: { id, userId },
    });

    if (!category) {
      throw new Error('Category not found or you do not have permission to delete it');
    }

    return this.prisma.category.delete({
      where: { id },
    });
  }
}
