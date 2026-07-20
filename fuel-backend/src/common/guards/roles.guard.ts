import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole } from '../../auth/jwt.strategy';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Enforces @Roles(...) metadata against the authenticated user's role.
 * Must run after AuthGuard('jwt') (which populates request.user).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const role: AppRole | undefined = request.user?.role;
    if (!role || !required.includes(role)) {
      throw new ForbiddenException('Insufficient role for this resource');
    }
    return true;
  }
}
