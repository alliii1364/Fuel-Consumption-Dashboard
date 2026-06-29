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
import { DepotRepository } from './services/depot.repository';
import { CreateDepotDto } from './dto/dispatch.dto';

@Controller('depots')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('manager')
export class DepotsController {
  constructor(private readonly depots: DepotRepository) {}

  @Get()
  async list(@Request() req: any) {
    const data = await this.depots.list(req.user.id);
    return { success: true, message: `${data.length} depot(s)`, data };
  }

  @Post()
  async create(@Request() req: any, @Body() dto: CreateDepotDto) {
    const id = await this.depots.create(req.user.id, dto);
    const data = await this.depots.get(req.user.id, id);
    return { success: true, message: 'Depot created', data };
  }

  @Patch(':depotId/default')
  async setDefault(@Request() req: any, @Param('depotId', ParseIntPipe) depotId: number) {
    await this.depots.setDefault(req.user.id, depotId);
    return { success: true, message: 'Default depot set', data: { depotId } };
  }

  @Delete(':depotId')
  async remove(@Request() req: any, @Param('depotId', ParseIntPipe) depotId: number) {
    await this.depots.remove(req.user.id, depotId);
    return { success: true, message: 'Depot removed', data: { depotId } };
  }
}
