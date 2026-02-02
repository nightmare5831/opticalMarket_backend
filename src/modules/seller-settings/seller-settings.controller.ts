import { Controller, Get, Post, Query, Res, UseGuards, Request } from '@nestjs/common';
import { Response } from 'express';
import { SellerSettingsService } from './seller-settings.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, UserRole } from '../../common/decorators/roles.decorator';

@Controller()
export class SellerSettingsController {
  constructor(private readonly service: SellerSettingsService) {}

  @Get('seller/mercadopago/oauth-url')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SELLER)
  getOAuthUrl(@Request() req: any) {
    return this.service.getOAuthUrl(req.user.sub);
  }

  @Post('seller/mercadopago/disconnect')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SELLER)
  disconnect(@Request() req: any) {
    return this.service.disconnect(req.user.sub);
  }

  @Get('mercadopago/callback')
  async oauthCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const redirectUrl = await this.service.handleOAuthCallback(code, state);
    return res.redirect(redirectUrl);
  }
}
