import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ShippingService } from './shipping.service';

@Controller('shipping')
export class ShippingController {
  constructor(private shippingService: ShippingService) {}

  @Get('calculate')
  async calculate(
    @Query('cep') cep: string,
    @Query('weight') weight?: string,
  ) {
    if (!cep) {
      throw new BadRequestException('CEP is required');
    }

    const cleanCep = cep.replace(/\D/g, '');
    if (cleanCep.length !== 8) {
      throw new BadRequestException('Invalid CEP format');
    }

    const weightKg = weight ? parseFloat(weight) : 0.5;
    return this.shippingService.calculateShipping(cleanCep, weightKg);
  }
}
