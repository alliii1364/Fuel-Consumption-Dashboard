import { SetMetadata } from '@nestjs/common';
import { AppRole } from '../../auth/jwt.strategy';

export const ROLES_KEY = 'roles';

/** Restrict a route/controller to the given role(s). Pair with RolesGuard. */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
