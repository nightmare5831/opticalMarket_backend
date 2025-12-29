import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { IsString, IsEmail } from 'class-validator';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

class CreateCheckoutDto {
  @IsString()
  orderId: string;

  @IsEmail()
  payerEmail: string;
}

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create')
  @UseGuards(JwtAuthGuard)
  async createCheckout(@Request() req: any, @Body() data: CreateCheckoutDto) {
    return this.paymentService.createCheckout(req.user.sub, data);
  }

  @Post('webhook')
  async webhook(@Body() data: any) {
    return this.paymentService.handleWebhook(data);
  }

  @Get(':orderId/status')
  @UseGuards(JwtAuthGuard)
  async getPaymentStatus(
    @Param('orderId') orderId: string,
    @Request() req: any,
  ) {
    return this.paymentService.getPaymentStatus(orderId, req.user.sub);
  }
}
