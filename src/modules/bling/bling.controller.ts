import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { BlingService } from './bling.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, UserRole } from '../../common/decorators/roles.decorator';
import { ConfigService } from '@nestjs/config';

@Controller('bling')
export class BlingController {
  private frontendUrl: string;

  constructor(
    private blingService: BlingService,
    private config: ConfigService,
  ) {
    this.frontendUrl = this.config.get('FRONTEND_URL') || 'http://localhost:8080';
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  async getStatus() {
    const configured = await this.blingService.isConfigured();
    const status = await this.blingService.getConnectionStatus();
    return {
      configured,
      ...status,
    };
  }

  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    if (!code) {
      return res.redirect(`${this.frontendUrl}/admin?bling_error=no_code`);
    }

    try {
      await this.blingService.exchangeCodeForTokens(code);
      return res.redirect(`${this.frontendUrl}/admin?bling_success=true`);
    } catch (error) {
      console.error('Bling OAuth error:', error);
      return res.redirect(`${this.frontendUrl}/admin?bling_error=token_exchange_failed`);
    }
  }

  @Get('sync/products')
  @UseGuards(JwtAuthGuard)
  async syncProducts() {
    return await this.blingService.syncProducts();
  }
}
