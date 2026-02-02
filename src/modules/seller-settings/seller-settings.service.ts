import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class SellerSettingsService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.clientId = this.configService.get('MERCADO_PAGO_CLIENT_ID') || '';
    this.clientSecret = this.configService.get('MERCADO_PAGO_CLIENT_SECRET') || '';
    this.redirectUri = `${this.configService.get('API_URL')}/api/mercadopago/callback`;
  }

  getOAuthUrl(sellerId: string) {
    return {
      url: `https://auth.mercadopago.com.br/authorization?client_id=${this.clientId}&response_type=code&platform_id=mp&state=${sellerId}&redirect_uri=${encodeURIComponent(this.redirectUri)}`,
    };
  }

  async handleOAuthCallback(code: string, state: string) {
    const frontendUrl = this.configService.get('FRONTEND_URL');
    try {
      const { data } = await axios.post('https://api.mercadopago.com/oauth/token', {
        client_secret: this.clientSecret,
        client_id: this.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
      });

      await this.prisma.user.update({
        where: { id: state },
        data: {
          mercadoPagoConnected: true,
          mercadoPagoAccountId: String(data.user_id),
          mercadoPagoAccessToken: data.access_token,
          mercadoPagoRefreshToken: data.refresh_token,
        },
      });

      return `${frontendUrl}/seller/profile?mp=connected`;
    } catch (error: any) {
      console.error('MP OAuth error:', error.response?.data || error.message);
      return `${frontendUrl}/seller/profile?mp=error`;
    }
  }

  async disconnect(sellerId: string) {
    await this.prisma.user.update({
      where: { id: sellerId },
      data: {
        mercadoPagoConnected: false,
        mercadoPagoAccountId: null,
        mercadoPagoAccessToken: null,
        mercadoPagoRefreshToken: null,
      },
    });
    return { disconnected: true };
  }

  async refreshSellerToken(sellerId: string): Promise<string | null> {
    const seller = await this.prisma.user.findUnique({
      where: { id: sellerId },
      select: { mercadoPagoRefreshToken: true },
    });
    if (!seller?.mercadoPagoRefreshToken) return null;

    try {
      const { data } = await axios.post('https://api.mercadopago.com/oauth/token', {
        client_secret: this.clientSecret,
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: seller.mercadoPagoRefreshToken,
      });

      await this.prisma.user.update({
        where: { id: sellerId },
        data: { mercadoPagoAccessToken: data.access_token, mercadoPagoRefreshToken: data.refresh_token },
      });
      return data.access_token;
    } catch {
      return null;
    }
  }
}
