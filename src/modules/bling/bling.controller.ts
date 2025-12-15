import { Controller, Get, Query, Res, UseGuards, Request } from '@nestjs/common';
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
  async getStatus(@Request() req) {
    const userId = req.user.id;
    const configured = await this.blingService.isConfigured(userId);
    const status = await this.blingService.getConnectionStatus(userId);
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

    // Extract userId from state parameter (should be passed during OAuth initiation)
    const userId = state;
    if (!userId) {
      return res.redirect(`${this.frontendUrl}/admin?bling_error=no_user_id`);
    }

    try {
      await this.blingService.exchangeCodeForTokens(code, userId);
      return res.redirect(`${this.frontendUrl}/admin?bling_success=true`);
    } catch (error) {
      console.error('Bling OAuth error:', error);
      return res.redirect(`${this.frontendUrl}/admin?bling_error=token_exchange_failed`);
    }
  }

  @Get('sync/products')
  @UseGuards(JwtAuthGuard)
  async syncProducts(@Request() req) {
    const userId = req.user.id;
    return await this.blingService.syncProducts(userId);
  }
}
