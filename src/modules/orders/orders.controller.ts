import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  IsString,
  IsArray,
  IsEnum,
  ValidateNested,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, UserRole } from '../../common/decorators/roles.decorator';
import { PaymentMethod, OrderStatus } from '@prisma/client';

class CartItemDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Min(1)
  quantity: number;
}

class CreateOrderDto {
  @IsString()
  addressId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];

  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsString()
  shippingMethod: string;

  @IsNumber()
  @Min(0)
  shippingCost: number;
}

class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(@Request() req: any) {
    return this.ordersService.findAll(req.user.sub);
  }

  @Get('seller')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SELLER, UserRole.ADMIN)
  async findSellerOrders(@Request() req: any) {
    return this.ordersService.findSellerOrders(req.user.sub);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @Request() req: any) {
    return this.ordersService.findOne(id, req.user.sub);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Request() req: any, @Body() data: CreateOrderDto) {
    return this.ordersService.create(req.user.sub, data);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SELLER, UserRole.ADMIN)
  async updateStatus(
    @Param('id') id: string,
    @Body() data: UpdateOrderStatusDto,
    @Request() req: any,
  ) {
    return this.ordersService.updateOrderStatus(id, req.user.sub, data.status);
  }

  @Post(':id/bling')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SELLER, UserRole.ADMIN)
  async createBlingOrder(@Param('id') id: string, @Request() req: any) {
    return this.ordersService.createBlingOrder(id, req.user.sub);
  }
}
