import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

@Injectable()
export class BlingService {
  private redirectUri: string;
  private apiUrl: string;
  private prisma: PrismaClient;

  constructor(private config: ConfigService) {
    this.redirectUri = this.config.get('BLING_REDIRECT_URI') || 'https://opticalmarket-backend.onrender.com/api/bling/callback';
    this.apiUrl = this.config.get('BLING_API_URL') || 'https://www.bling.com.br/Api/v3';
    this.prisma = new PrismaClient();
  }

  async saveCredentials(userId: string, clientId: string, clientSecret: string, state: string): Promise<void> {
    await this.prisma.blingToken.upsert({
      where: { userId },
      update: { clientId, clientSecret, state },
      create: { userId, clientId, clientSecret, state },
    });
  }

  async handleOAuthCallback(code: string, state: string): Promise<void> {
    const record = await this.prisma.blingToken.findUnique({
      where: { state },
    });

    if (!record) {
      throw new Error('Invalid state parameter');
    }

    const auth = Buffer.from(`${record.clientId}:${record.clientSecret}`).toString('base64');

    const response = await axios.post(
      `${this.apiUrl}/oauth/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.redirectUri,
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Authorization': `Basic ${auth}`,
        },
      }
    );

    const { access_token, refresh_token, expires_in, scope } = response.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await this.prisma.blingToken.update({
      where: { userId: record.userId },
      data: {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: expiresAt,
        scope: scope || null,
      },
    });
  }

  async refreshAccessToken(userId: string): Promise<void> {
    const token = await this.prisma.blingToken.findUnique({
      where: { userId },
    });
    if (!token) {
      throw new Error('No token found for user');
    }
    if (!token.refreshToken) {
      throw new Error('No refresh token available');
    }

    const auth = Buffer.from(`${token.clientId}:${token.clientSecret}`).toString('base64');

    try {
      const response = await axios.post(
        `${this.apiUrl}/oauth/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${auth}`,
          },
        }
      );

      const { access_token, refresh_token, expires_in } = response.data;
      const expiresAt = new Date(Date.now() + expires_in * 1000);

      await this.prisma.blingToken.update({
        where: { userId },
        data: {
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt: expiresAt,
        },
      });
    } catch (error) {
      throw new Error(`Failed to refresh token: ${error.response?.data?.error || error.message}`);
    }
  }

  async getValidAccessToken(userId: string): Promise<string> {
    const token = await this.prisma.blingToken.findUnique({
      where: { userId },
    });
    if (!token || !token.accessToken) {
      throw new Error('Bling not connected. Please authenticate first.');
    }
    if (!token.expiresAt) {
      throw new Error('Token expiration date not found. Please re-authenticate.');
    }

    if (new Date(token.expiresAt).getTime() - Date.now() < 5 * 60 * 1000) {
      await this.refreshAccessToken(userId);
      const refreshedToken = await this.prisma.blingToken.findUnique({
        where: { userId },
      });
      if (!refreshedToken?.accessToken) {
        throw new Error('Failed to refresh access token');
      }
      return refreshedToken.accessToken;
    }

    return token.accessToken;
  }

  async createCategoryInBling(userId: string, categoryName: string): Promise<any> {
    try {
      const accessToken = await this.getValidAccessToken(userId);

      const blingCategoryData = {
        descricao: categoryName,
      };

      console.log('Creating category in Bling:', blingCategoryData);

      const response = await axios.post(
        `${this.apiUrl}/categorias/produtos`,
        blingCategoryData,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('Category successfully created in Bling:', response.data);

      // Extract the Bling category ID from the response
      const blingCategoryId = response.data?.data?.id;

      return {
        success: true,
        data: response.data,
        blingId: blingCategoryId,
        message: 'Category successfully created in Bling ERP',
      };
    } catch (error) {
      console.error('Failed to create category in Bling:', JSON.stringify(error.response?.data, null, 2) || error.message);

      if (error.response?.status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please reconnect your Bling account.',
          code: 'AUTH_ERROR',
        };
      }

      if (error.response?.status === 400) {
        return {
          success: false,
          error: 'Invalid category data. Please check the category details.',
          code: 'VALIDATION_ERROR',
          details: error.response?.data,
        };
      }

      return {
        success: false,
        error: error.message || 'Failed to create category in Bling ERP',
        code: 'CREATE_ERROR',
        details: error.response?.data,
      };
    }
  }

  async syncCategories(userId: string) {
    try {
      const accessToken = await this.getValidAccessToken(userId);

      const response = await axios.get(`${this.apiUrl}/categorias/produtos`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      const blingCategories = response.data.data || [];

      const savedCategories = [];
      const errors = [];

      for (const blingCategory of blingCategories) {
        try {
          const slug = blingCategory.descricao
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

          // Check if category exists by blingId and userId
          const existingCategory = await this.prisma.category.findFirst({
            where: {
              blingId: blingCategory.id,
              userId: userId,
            },
          });

          let savedCategory;
          if (existingCategory) {
            // Update existing category
            savedCategory = await this.prisma.category.update({
              where: { id: existingCategory.id },
              data: {
                name: blingCategory.descricao,
                slug,
              },
            });
          } else {
            // Create new category
            savedCategory = await this.prisma.category.create({
              data: {
                name: blingCategory.descricao,
                slug,
                blingId: blingCategory.id,
                userId: userId,
              },
            });
          }

          savedCategories.push(savedCategory);
        } catch (categoryError) {
          errors.push({
            category: blingCategory.descricao || 'Unknown',
            error: categoryError.message,
          });
        }
      }

      return {
        success: true,
        data: savedCategories,
        total: blingCategories.length,
        synced: savedCategories.length,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined,
        message: `Synced ${savedCategories.length} of ${blingCategories.length} categories from Bling ERP${errors.length > 0 ? ` (${errors.length} failed)` : ''}`,
      };
    } catch (error) {
      console.error('Bling API Error:', error.response?.data);

      if (error.response?.status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please reconnect your Bling account.',
          code: 'AUTH_ERROR',
        };
      }

      return {
        success: false,
        error: error.message || 'Unknown error occurred during category sync',
        code: 'SYNC_ERROR',
        details: error.response?.data,
      };
    }
  }

  async syncProducts(userId: string) {
    try {
      const accessToken = await this.getValidAccessToken(userId);

      // First sync categories
      await this.syncCategories(userId);

      const response = await axios.get(`${this.apiUrl}/produtos`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      const blingProducts = response.data.data || [];

      if (blingProducts.length === 0) {
        console.log('⚠️ No products found in Bling ERP. The account may be empty or you need to add products first.');
        return {
          success: true,
          data: [],
          total: 0,
          synced: 0,
          failed: 0,
          errors: [],
          message: 'No products found in Bling ERP',
        };
      }

      let defaultCategory = await this.prisma.category.findFirst({
        where: {
          slug: 'uncategorized',
          userId: userId,
        },
      });

      if (!defaultCategory) {
        defaultCategory = await this.prisma.category.create({
          data: {
            name: 'Uncategorized',
            slug: 'uncategorized',
            userId: userId,
          },
        });
      }

      const savedProducts = [];
      const errors = [];

      for (const blingProduct of blingProducts) {
        try {
          if (!blingProduct.codigo || blingProduct.codigo.trim() === '') {
            errors.push({
              product: blingProduct.nome || 'Unknown',
              error: 'Missing SKU (codigo)',
            });
            continue;
          }

          // Find category by name if it exists in Bling product
          let categoryId = defaultCategory.id;
          if (blingProduct.categoria?.descricao) {
            const categorySlug = blingProduct.categoria.descricao
              .toLowerCase()
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');

            const category = await this.prisma.category.findFirst({
              where: {
                slug: categorySlug,
                userId: userId,
              },
            });

            if (category) {
              categoryId = category.id;
            }
          }

          const productData = {
            sku: blingProduct.codigo,
            name: blingProduct.nome || 'Unnamed Product',
            description: blingProduct.descricao || null,
            price: parseFloat(blingProduct.preco) || 0,
            stock: blingProduct.estoque?.saldoVirtualTotal || 0,
            images: blingProduct.imagemURL ? [blingProduct.imagemURL] : [],
            categoryId: categoryId,
            sellerId: userId,
          };

          const savedProduct = await this.prisma.product.upsert({
            where: { sku: productData.sku },
            update: {
              name: productData.name,
              description: productData.description,
              price: productData.price,
              stock: productData.stock,
              images: productData.images,
              categoryId: productData.categoryId,
              sellerId: userId,
            },
            create: productData,
          });

          savedProducts.push(savedProduct);
        } catch (productError) {
          errors.push({
            product: blingProduct.nome || blingProduct.codigo || 'Unknown',
            error: productError.message,
          });
        }
      }

      return {
        success: true,
        data: savedProducts,
        total: blingProducts.length,
        synced: savedProducts.length,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined,
        message: `Synced ${savedProducts.length} of ${blingProducts.length} products from Bling ERP${errors.length > 0 ? ` (${errors.length} failed)` : ''}`,
      };
    } catch (error) {
      console.error('Bling API Error:', error.response?.data);

      if (error.response?.status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please reconnect your Bling account.',
          code: 'AUTH_ERROR',
        };
      }

      if (error.response?.status === 403) {
        return {
          success: false,
          error: 'Access denied. Check your Bling API permissions.',
          code: 'PERMISSION_ERROR',
        };
      }

      if (error.response?.status === 429) {
        return {
          success: false,
          error: 'Rate limit exceeded. Please try again later.',
          code: 'RATE_LIMIT',
        };
      }

      return {
        success: false,
        error: error.message || 'Unknown error occurred during sync',
        code: 'SYNC_ERROR',
        details: error.response?.data,
      };
    }
  }

  async isConfigured(userId: string): Promise<boolean> {
    const token = await this.prisma.blingToken.findUnique({
      where: { userId },
    });
    return !!token && !!token.accessToken;
  }

  async getConnectionStatus(userId: string): Promise<any> {
    const token = await this.prisma.blingToken.findUnique({
      where: { userId },
    });
    if (!token) {
      return {
        connected: false,
        message: 'Not connected to Bling',
      };
    }

    if (!token.expiresAt) {
      return {
        connected: true,
        expiresAt: null,
        isExpired: false,
        message: 'Connected to Bling (expiration unknown)',
      };
    }

    const isExpired = new Date(token.expiresAt).getTime() < Date.now();
    return {
      connected: true,
      expiresAt: token.expiresAt,
      isExpired: isExpired,
      message: isExpired ? 'Token expired, will refresh on next request' : 'Connected to Bling',
    };
  }

  async pushProductToBling(userId: string, productData: {
    sku: string;
    name: string;
    description?: string;
    price: number;
    stock: number;
    blingImageUrl?: string;
    blingCategoryId?: number;
  }): Promise<any> {
    try {
      const accessToken = await this.getValidAccessToken(userId);

      const blingProductData: any = {
        nome: productData.name,
        codigo: productData.sku,
        preco: productData.price,
        tipo: 'P',
        situacao: 'A',
        formato: 'S',
        descricaoCurta: productData.description?.substring(0, 255) || productData.name,
        descricao: productData.description || '',
        unidade: 'UN',
        pesoLiquido: 0.1,
        pesoBruto: 0.1,
        estoque: {
          minimo: 0,
          maximo: 9999,
          crossdocking: 0,
          localizacao: ''
        },
        actionEstoque: 'A',
        dimensoes: {
          largura: 0,
          altura: 0,
          profundidade: 0,
          unidadeMedida: 1
        },
        marca: '',
        gtin: '',
        gtinEmbalagem: '',
        tipoProducao: 'P',
        condicao: 0,
        freteGratis: false,
        linkExterno: '',
        observacoes: '',
        descricaoComplementar: '',
        categoria: {
          id: productData.blingCategoryId || null
        },
        estoquePorDeposito: [
          {
            saldo: productData.stock,
            depositoId: null
          }
        ]
      };

      if (productData.blingImageUrl) {
        blingProductData.imagem = {
          externa: {
            url: productData.blingImageUrl
          }
        };
        console.log('Adding Bling-hosted image to product:', productData.blingImageUrl);
      }

      console.log('Sending product to Bling:', JSON.stringify(blingProductData, null, 2));

      const response = await axios.post(
        `${this.apiUrl}/produtos`,
        blingProductData,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('Product successfully created in Bling:', response.data);

      return {
        success: true,
        data: response.data,
        message: 'Product successfully created in Bling ERP',
      };
    } catch (error) {
      console.error('Failed to push product to Bling:', JSON.stringify(error.response?.data, null, 2) || error.message);

      if (error.response?.status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please reconnect your Bling account.',
          code: 'AUTH_ERROR',
        };
      }

      if (error.response?.status === 400) {
        return {
          success: false,
          error: 'Invalid product data. Please check the product details.',
          code: 'VALIDATION_ERROR',
          details: error.response?.data,
        };
      }

      return {
        success: false,
        error: error.message || 'Failed to create product in Bling ERP',
        code: 'PUSH_ERROR',
        details: error.response?.data,
      };
    }
  }
}
