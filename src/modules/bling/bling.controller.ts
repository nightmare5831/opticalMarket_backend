import { Controller, Get, Post, Body, Query, Res, UseGuards, Request } from '@nestjs/common';
import { Response } from 'express';
import { BlingService } from './bling.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ConfigService } from '@nestjs/config';

@Controller('bling')
export class BlingController {
  private frontendUrl: string;

  constructor(
    private blingService: BlingService,
    private config: ConfigService,
  ) {
    this.frontendUrl = this.config.get('FRONTEND_URL') || 'https://optical-market-frontend.vercel.app';
  }

  @Post('credentials')
  @UseGuards(JwtAuthGuard)
  async saveCredentials(@Request() req: any, @Body() body: { clientId: string; clientSecret: string; state: string }) {
    const userId = req.user.sub;
    await this.blingService.saveCredentials(userId, body.clientId, body.clientSecret, body.state);
    return { success: true };
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  async getStatus(@Request() req: any) {
    const userId = req.user.sub;
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
      return res.redirect(`${this.frontendUrl}?bling_error=no_code`);
    }

    if (!state) {
      return res.redirect(`${this.frontendUrl}?bling_error=no_state`);
    }

    try {
      await this.blingService.handleOAuthCallback(code, state);
      return res.redirect(`${this.frontendUrl}?bling_success=true`);
    } catch (error) {
      console.error('Bling OAuth error:', error);
      return res.redirect(`${this.frontendUrl}?bling_error=token_exchange_failed`);
    }
  }

  @Get('sync/products')
  @UseGuards(JwtAuthGuard)
  async syncProducts(@Request() req: any) {
    const userId = req.user.sub;
    return await this.blingService.syncProducts(userId);
  }

  @Get('sync/categories')
  @UseGuards(JwtAuthGuard)
  async syncCategories(@Request() req: any) {
    const userId = req.user.sub;
    return await this.blingService.syncCategories(userId);
  }
}
