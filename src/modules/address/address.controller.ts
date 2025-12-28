import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { IsString, IsBoolean, IsOptional, MinLength } from 'class-validator';
import { AddressService } from './address.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

class CreateAddressDto {
  @IsString()
  @MinLength(3)
  street: string;

  @IsString()
  @MinLength(1)
  number: string;

  @IsString()
  @IsOptional()
  complement?: string;

  @IsString()
  @MinLength(2)
  neighborhood: string;

  @IsString()
  @MinLength(2)
  city: string;

  @IsString()
  @MinLength(2)
  state: string;

  @IsString()
  @MinLength(8)
  zipCode: string;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

class UpdateAddressDto {
  @IsString()
  @MinLength(3)
  @IsOptional()
  street?: string;

  @IsString()
  @MinLength(1)
  @IsOptional()
  number?: string;

  @IsString()
  @IsOptional()
  complement?: string;

  @IsString()
  @MinLength(2)
  @IsOptional()
  neighborhood?: string;

  @IsString()
  @MinLength(2)
  @IsOptional()
  city?: string;

  @IsString()
  @MinLength(2)
  @IsOptional()
  state?: string;

  @IsString()
  @MinLength(8)
  @IsOptional()
  zipCode?: string;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

@Controller('address')
export class AddressController {
  constructor(private readonly addressService: AddressService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(@Request() req: any) {
    return this.addressService.findAll(req.user.sub);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @Request() req: any) {
    return this.addressService.findOne(id, req.user.sub);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Request() req: any, @Body() data: CreateAddressDto) {
    return this.addressService.create(req.user.sub, data);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id') id: string,
    @Request() req: any,
    @Body() data: UpdateAddressDto,
  ) {
    return this.addressService.update(id, req.user.sub, data);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@Param('id') id: string, @Request() req: any) {
    return this.addressService.remove(id, req.user.sub);
  }
}
