import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { DriverRepository } from './services/driver.repository';
import { CreateDriverDto, SetPinDto, UpdateDriverDto } from './dto/dispatch.dto';

/** Manager-facing driver management (reuses gs_user_object_drivers). */
@Controller('drivers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('manager')
export class DriversController {
  constructor(private readonly drivers: DriverRepository) {}

  @Get()
  async list(@Request() req: any) {
    const data = await this.drivers.list(req.user.id);
    return { success: true, message: `${data.length} driver(s)`, data };
  }

  @Post()
  async create(@Request() req: any, @Body() dto: CreateDriverDto) {
    const driverId = await this.drivers.create(req.user.id, dto);
    const data = await this.drivers.get(req.user.id, driverId);
    return { success: true, message: 'Driver created', data };
  }

  @Get(':driverId')
  async get(@Request() req: any, @Param('driverId', ParseIntPipe) driverId: number) {
    const data = await this.drivers.get(req.user.id, driverId);
    return { success: true, message: 'Driver fetched', data };
  }

  @Patch(':driverId')
  async update(
    @Request() req: any,
    @Param('driverId', ParseIntPipe) driverId: number,
    @Body() dto: UpdateDriverDto,
  ) {
    await this.drivers.update(req.user.id, driverId, dto);
    const data = await this.drivers.get(req.user.id, driverId);
    return { success: true, message: 'Driver updated', data };
  }

  @Delete(':driverId')
  async remove(@Request() req: any, @Param('driverId', ParseIntPipe) driverId: number) {
    await this.drivers.remove(req.user.id, driverId);
    return { success: true, message: 'Driver deleted', data: { driverId } };
  }

  /** Set/reset a driver's login PIN. The driver logs in with their driver ID + PIN. */
  @Post(':driverId/pin')
  async setPin(
    @Request() req: any,
    @Param('driverId', ParseIntPipe) driverId: number,
    @Body() dto: SetPinDto,
  ) {
    await this.drivers.setPin(req.user.id, driverId, dto.pin);
    return { success: true, message: 'Driver PIN set', data: { driverId } };
  }

  @Patch(':driverId/login/disable')
  async disableLogin(
    @Request() req: any,
    @Param('driverId', ParseIntPipe) driverId: number,
  ) {
    await this.drivers.setLoginActive(req.user.id, driverId, false);
    return { success: true, message: 'Driver login disabled', data: { driverId } };
  }
}
