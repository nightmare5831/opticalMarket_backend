import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsEmail,
  Min,
  Max,
} from 'class-validator';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PaymentMethod } from '@prisma/client';

class CreatePaymentDto {
  @IsString()
  orderId: string;

  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsString()
  @IsOptional()
  cardToken?: string;

  @IsNumber()
  @Min(1)
  @Max(12)
  @IsOptional()
  installments?: number;

  @IsEmail()
  payerEmail: string;
}

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create')
  @UseGuards(JwtAuthGuard)
  async createPayment(@Request() req: any, @Body() data: CreatePaymentDto) {
    return this.paymentService.createPayment(req.user.sub, data);
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
