import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UserRole, UserStatus, SellerType } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(data: {
    email: string;
    password: string;
    name: string;
    role?: string;
    sellerType?: string;
    cnpj?: string;
    legalCompanyName?: string;
  }) {
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // Only allow CUSTOMER or SELLER roles during registration
    const allowedRoles: UserRole[] = [UserRole.CUSTOMER, UserRole.SELLER];
    const userRole: UserRole = data.role && allowedRoles.includes(data.role as UserRole)
      ? (data.role as UserRole)
      : UserRole.CUSTOMER;

    // Validate seller type if role is SELLER
    let sellerType: SellerType | null = null;
    if (userRole === UserRole.SELLER) {
      if (data.sellerType && ['B2C_MERCHANT', 'B2B_SUPPLIER'].includes(data.sellerType)) {
        sellerType = data.sellerType as SellerType;
      } else {
        // Default to B2C_MERCHANT if not specified
        sellerType = SellerType.B2C_MERCHANT;
      }
    }

    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        password: await bcrypt.hash(data.password, 10),
        name: data.name,
        role: userRole,
        status: userRole === UserRole.CUSTOMER ? UserStatus.ACTIVE : UserStatus.PENDING,
        sellerType: sellerType,
        cnpj: data.cnpj || null,
        legalCompanyName: data.legalCompanyName || null,
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        sellerType: user.sellerType,
        cnpj: user.cnpj,
        legalCompanyName: user.legalCompanyName,
        mercadoPagoConnected: user.mercadoPagoConnected,
      },
      token: this.jwtService.sign({ sub: user.id, email: user.email, role: user.role }),
    };
  }

  async login(data: { email: string; password: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (!user || !(await bcrypt.compare(data.password, user.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Option B: Allow PENDING sellers to log in (with restricted permissions)
    // Only block SUSPENDED users
    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Your account has been suspended. Please contact support.');
    }

    // Include status and sellerType in JWT token for authorization checks
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        sellerType: user.sellerType,
        cnpj: user.cnpj,
        legalCompanyName: user.legalCompanyName,
        mercadoPagoConnected: user.mercadoPagoConnected,
      },
      token: this.jwtService.sign({
        sub: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
      }),
    };
  }
}
