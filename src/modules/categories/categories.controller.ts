import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  @Get()
  async findAll(@Request() req: any) {
    // Optional authentication: extract user if available from Authorization header
    const userId = req.user?.sub;
    const userRole = req.user?.role;
    return this.categoriesService.findAll(userId, userRole);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @Request() req: any) {
    return this.categoriesService.findOne(id, req.user.sub);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SELLER')
  async create(@Body() data: { name: string; slug: string }, @Request() req: any) {
    return this.categoriesService.create(data, req.user.sub);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SELLER')
  async update(@Param('id') id: string, @Body() data: Partial<{ name: string; slug: string }>, @Request() req: any) {
    return this.categoriesService.update(id, data, req.user.sub);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SELLER')
  async delete(@Param('id') id: string, @Request() req: any) {
    return this.categoriesService.delete(id, req.user.sub);
  }
}
