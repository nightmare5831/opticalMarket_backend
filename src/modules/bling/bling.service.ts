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
    this.redirectUri = this.config.get('BLING_REDIRECT_URI') || 'https://opticalmarket-backend-6pfl.onrender.com/api/bling/callback';
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

  async updateCategoryInBling(userId: string, blingId: number, categoryName: string): Promise<any> {
    try {
      const accessToken = await this.getValidAccessToken(userId);

      const response = await axios.put(
        `${this.apiUrl}/categorias/produtos/${blingId}`,
        { descricao: categoryName },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      console.error('Failed to update category in Bling:', error.response?.data || error.message);

      if (error.response?.status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please reconnect your Bling account.',
          code: 'AUTH_ERROR',
        };
      }

      return {
        success: false,
        error: error.message || 'Failed to update category in Bling ERP',
        code: 'UPDATE_ERROR',
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

      // Debug: log the first product to see the actual structure from Bling
      if (blingProducts.length > 0) {
        console.log('Bling product structure sample:', JSON.stringify(blingProducts[0], null, 2));
      }

      // Delete all existing products for this user (or unowned products) before syncing
      await this.prisma.product.deleteMany({
        where: {
          OR: [
            { sellerId: userId },
            { sellerId: null },
          ],
        },
      });

      if (blingProducts.length === 0) {
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

      const savedProducts = [];
      const errors = [];

      for (const blingProductBasic of blingProducts) {
        try {
          if (!blingProductBasic.codigo || blingProductBasic.codigo.trim() === '') {
            errors.push({
              product: blingProductBasic.nome || 'Unknown',
              error: 'Missing SKU (codigo)',
            });
            continue;
          }

          // Fetch full product details to get custom fields (R2_link)
          const productDetailResponse = await axios.get(
            `${this.apiUrl}/produtos/${blingProductBasic.id}`,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json',
              },
            }
          );
          const blingProduct = productDetailResponse.data.data || blingProductBasic;

          // Debug: log full product detail for first product
          if (savedProducts.length === 0) {
            console.log('Bling product FULL detail sample:', JSON.stringify(blingProduct, null, 2));
          }

          // Find category by blingId - skip product if no valid category
          if (!blingProduct.categoria?.id) {
            errors.push({
              product: blingProduct.nome || blingProduct.codigo || 'Unknown',
              error: 'No category assigned in Bling',
            });
            continue;
          }

          const category = await this.prisma.category.findFirst({
            where: {
              blingId: blingProduct.categoria.id,
              userId: userId,
            },
          });

          if (!category) {
            errors.push({
              product: blingProduct.nome || blingProduct.codigo || 'Unknown',
              error: `Category with Bling ID ${blingProduct.categoria.id} not found`,
            });
            continue;
          }

          // Get image URL from linkExterno
          const images: string[] = blingProduct.linkExterno ? [blingProduct.linkExterno] : [];

          const savedProduct = await this.prisma.product.create({
            data: {
              sku: blingProduct.codigo,
              name: blingProduct.nome || 'Unnamed Product',
              description: blingProduct.descricao || null,
              price: parseFloat(blingProduct.preco) || 0,
              stock: blingProduct.estoque?.saldoVirtualTotal || 0,
              images: images,
              categoryId: category.id,
              sellerId: userId,
            },
          });

          savedProducts.push(savedProduct);
        } catch (productError) {
          errors.push({
            product: blingProductBasic.nome || blingProductBasic.codigo || 'Unknown',
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

  async createOrderInBling(userId: string, orderData: {
    orderNumber: string;
    customer: {
      name: string;
      email: string;
    };
    address: {
      street: string;
      number: string;
      complement?: string;
      neighborhood: string;
      city: string;
      state: string;
      zipCode: string;
    };
    items: Array<{
      sku: string;
      name: string;
      quantity: number;
      price: number;
    }>;
    total: number;
    paymentMethod: string;
  }): Promise<any> {
    try {
      const accessToken = await this.getValidAccessToken(userId);

      const blingOrderData = {
        numero: orderData.orderNumber,
        data: new Date().toISOString().split('T')[0],
        contato: {
          nome: orderData.customer.name,
          email: orderData.customer.email,
        },
        itens: orderData.items.map(item => ({
          codigo: item.sku,
          descricao: item.name,
          quantidade: item.quantity,
          valor: item.price,
          unidade: 'UN',
        })),
        transporte: {
          enderecoEntrega: {
            endereco: orderData.address.street,
            numero: orderData.address.number,
            complemento: orderData.address.complement || '',
            bairro: orderData.address.neighborhood,
            municipio: orderData.address.city,
            uf: orderData.address.state,
            cep: orderData.address.zipCode.replace(/\D/g, ''),
            pais: 'Brasil',
          },
        },
        observacoes: `Payment: ${orderData.paymentMethod}`,
      };

      console.log('Creating order in Bling:', JSON.stringify(blingOrderData, null, 2));

      const response = await axios.post(
        `${this.apiUrl}/pedidos/vendas`,
        blingOrderData,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('Order successfully created in Bling:', response.data);

      return {
        success: true,
        data: response.data,
        blingOrderId: response.data?.data?.id,
        message: 'Order successfully created in Bling ERP',
      };
    } catch (error) {
      console.error('Failed to create order in Bling:', JSON.stringify(error.response?.data, null, 2) || error.message);

      if (error.response?.status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please reconnect your Bling account.',
          code: 'AUTH_ERROR',
        };
      }

      if (error.response?.status === 400) {
        const blingError = error.response?.data?.error?.description ||
                          error.response?.data?.error?.message ||
                          JSON.stringify(error.response?.data);
        return {
          success: false,
          error: `Invalid order data: ${blingError}`,
          code: 'VALIDATION_ERROR',
          details: error.response?.data,
        };
      }

      return {
        success: false,
        error: error.message || 'Failed to create order in Bling ERP',
        code: 'CREATE_ERROR',
        details: error.response?.data,
      };
    }
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
        linkExterno: productData.blingImageUrl || '',
        observacoes: '',
        descricaoComplementar: '',
        categoria: {
          id: productData.blingCategoryId || null
        },
      };

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
