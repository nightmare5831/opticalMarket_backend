import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlingService } from '../bling/bling.service';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private blingService: BlingService,
  ) {}

  async findAll(filters?: { categoryId?: string; minPrice?: number; maxPrice?: number; page?: number; limit?: number }) {
    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters?.categoryId) {
      where.categoryId = filters.categoryId;
    }

    if (filters?.minPrice !== undefined || filters?.maxPrice !== undefined) {
      where.price = {};
      if (filters.minPrice !== undefined) where.price.gte = filters.minPrice;
      if (filters.maxPrice !== undefined) where.price.lte = filters.maxPrice;
    }

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: true, seller: { select: { id: true, name: true, email: true } } },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: products,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findBySellerId(sellerId: string) {
    return this.prisma.product.findMany({
      where: { sellerId },
      include: { category: true, seller: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.product.findUnique({
      where: { id },
      include: { category: true, seller: { select: { id: true, name: true, email: true } } },
    });
  }

  async create(data: { sku: string; name: string; description?: string; price: number; stock: number; categoryId: string; sellerId?: string; imageFile?: Express.Multer.File }) {
    const existingProduct = await this.prisma.product.findUnique({
      where: { sku: data.sku },
    });

    if (existingProduct) {
      throw new Error(`Product with SKU ${data.sku} already exists`);
    }

    console.log('Image file received:', data.imageFile ? `Yes (${data.imageFile.originalname})` : 'No');

    let imageUrl: string | null = null;
    const isBlingConnected = data.sellerId ? await this.blingService.isConfigured(data.sellerId) : false;

    // Step 1: Upload image to R2
    if (data.imageFile) {
      console.log('Uploading image to R2...');
      imageUrl = await this.uploadImageToR2(data.imageFile);
      console.log('Image uploaded to R2:', imageUrl);
    } else {
      console.log('No image file provided, skipping upload');
    }

    // Step 2: Get Bling category ID from the selected category
    let blingCategoryId: number | undefined;
    if (data.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: data.categoryId },
      });
      blingCategoryId = category?.blingId || undefined;
    }

    // Step 3: Push to Bling first (if connected)
    if (isBlingConnected && data.sellerId) {
      try {
        const blingResult = await this.blingService.pushProductToBling(data.sellerId, {
          sku: data.sku,
          name: data.name,
          description: data.description,
          price: data.price,
          stock: data.stock,
          blingImageUrl: imageUrl || undefined, // Send R2 URL to Bling
          blingCategoryId: blingCategoryId,
        });

        if (!blingResult.success) {
          throw new Error(blingResult.error || 'Failed to create product in Bling');
        }
      } catch (error) {
        console.error('Error syncing to Bling:', error);
        throw new Error(`Failed to create product in Bling: ${error.message}`);
      }
    }

    // Step 4: Save to database after Bling sync succeeds
    const { imageFile, ...productData } = data;
    const product = await this.prisma.product.create({
      data: {
        ...productData,
        images: imageUrl ? [imageUrl] : [],
      },
      include: { category: true, seller: { select: { id: true, name: true, email: true } } },
    });

    return product;
  }

  private async uploadImageToR2(file: Express.Multer.File): Promise<string> {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const fs = require('fs');

    const accountId = '6137017bca9a8bf23a027bb0e412e9a2';

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });

    const fileName = `image/${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`;
    const fileContent = fs.readFileSync(file.path);

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: fileName,
      Body: fileContent,
      ContentType: file.mimetype,
    }));

    fs.unlinkSync(file.path);

    return `${process.env.R2_PUBLIC_URL}/${fileName}`;
  }

  async update(id: string, data: Partial<{ name: string; description: string; price: number; stock: number; categoryId: string; images: string[] }>) {
    return this.prisma.product.update({
      where: { id },
      data,
      include: { category: true, seller: { select: { id: true, name: true, email: true } } },
    });
  }

  async delete(id: string) {
    return this.prisma.product.delete({
      where: { id },
    });
  }
}
