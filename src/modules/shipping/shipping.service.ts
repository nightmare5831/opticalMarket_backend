import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ShippingOption {
  service: string;
  name: string;
  price: number;
  deliveryDays: number;
}

@Injectable()
export class ShippingService {
  private readonly originCep: string;
  private readonly apiUrl: string;
  private readonly user: string;
  private readonly token: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(private configService: ConfigService) {
    this.originCep = this.configService.get('CORREIOS_ORIGIN_CEP', '01310100');
    // Always use sandbox for now - change to production later
    this.apiUrl = 'https://apihom.correios.com.br';
    this.user = this.configService.get('CORREIOS_USER', '');
    this.token = this.configService.get('CORREIOS_TOKEN', '');
  }

  async calculateShipping(
    destinationCep: string,
    weightKg: number = 0.5,
  ): Promise<ShippingOption[]> {
    const cep = destinationCep.replace(/\D/g, '');

    // Try new API if credentials exist, otherwise use fallback
    if (this.user && this.token) {
      try {
        return await this.fetchFromNewApi(cep, weightKg);
      } catch (error) {
        console.error('Correios API error, using fallback:', error);
      }
    }

    // Fallback: region-based calculation
    return this.calculateFallbackOptions(cep);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const response = await fetch(`${this.apiUrl}/token/v1/autentica/cartaopostagem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${this.user}:${this.token}`).toString('base64'),
      },
      body: JSON.stringify({ numero: this.configService.get('CORREIOS_CARTAO', '') }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error('Failed to authenticate with Correios');
    }

    const data = await response.json();
    const token: string = data.token;
    this.accessToken = token;
    this.tokenExpiry = Date.now() + (data.expiraEm * 1000) - 60000; // 1 min buffer
    return token;
  }

  private async fetchFromNewApi(
    destinationCep: string,
    weightKg: number,
  ): Promise<ShippingOption[]> {
    const token = await this.getAccessToken();

    const services = [
      { code: '03220', name: 'SEDEX' },  // SEDEX contract
      { code: '03298', name: 'PAC' },    // PAC contract
    ];

    const results: ShippingOption[] = [];

    for (const service of services) {
      try {
        const response = await fetch(`${this.apiUrl}/preco/v1/nacional/${service.code}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            cepOrigem: this.originCep,
            cepDestino: destinationCep,
            psObjeto: Math.ceil(weightKg * 1000), // grams
            tpObjeto: 2, // Box
            comprimento: 20,
            largura: 15,
            altura: 10,
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const data = await response.json();
          results.push({
            service: service.code,
            name: service.name,
            price: parseFloat(data.pcFinal || data.pcBase),
            deliveryDays: parseInt(data.prazoEntrega, 10),
          });
        }
      } catch {
        // Skip failed service
      }
    }

    if (results.length === 0) {
      return this.calculateFallbackOptions(destinationCep);
    }

    return results.sort((a, b) => a.price - b.price);
  }

  private calculateFallbackOptions(destinationCep: string): ShippingOption[] {
    const region = destinationCep.substring(0, 1);
    const regionMultiplier: Record<string, number> = {
      '0': 1.0, '1': 1.0,   // SP
      '2': 1.1,              // RJ/ES
      '3': 1.15,             // MG
      '4': 1.2,              // BA/SE
      '5': 1.25,             // PE/AL/PB/RN
      '6': 1.3,              // CE/PI/MA/PA/AP/AM/RR/AC
      '7': 1.2,              // DF/GO/TO/MT/MS/RO
      '8': 1.15,             // PR/SC
      '9': 1.2,              // RS
    };

    const multiplier = regionMultiplier[region] || 1.2;

    return [
      {
        service: 'PAC',
        name: 'PAC',
        price: Math.round(18 * multiplier * 100) / 100,
        deliveryDays: 8,
      },
      {
        service: 'SEDEX',
        name: 'SEDEX',
        price: Math.round(25 * multiplier * 100) / 100,
        deliveryDays: 3,
      },
    ];
  }
}
