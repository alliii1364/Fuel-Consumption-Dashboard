import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { DriverLoginDto, LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    this.logger.log(`Login attempt for username: ${dto.username}`);
    const result = await this.authService.login(dto);
    return {
      success: true,
      message: 'Login successful',
      data: result,
    };
  }

  @Post('driver/login')
  @HttpCode(HttpStatus.OK)
  async driverLogin(@Body() dto: DriverLoginDto) {
    this.logger.log(`Driver login attempt for driver ID: ${dto.driverId}`);
    const result = await this.authService.driverLogin(dto);
    return {
      success: true,
      message: 'Login successful',
      data: result,
    };
  }
}
