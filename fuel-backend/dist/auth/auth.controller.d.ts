import { AuthService } from './auth.service';
import { DriverLoginDto, LoginDto } from './dto/login.dto';
export declare class AuthController {
    private readonly authService;
    private readonly logger;
    constructor(authService: AuthService);
    login(dto: LoginDto): Promise<{
        success: boolean;
        message: string;
        data: {
            token: string;
            expiresIn: string;
        };
    }>;
    driverLogin(dto: DriverLoginDto): Promise<{
        success: boolean;
        message: string;
        data: {
            token: string;
            expiresIn: string;
            driver: {
                driverId: number;
                name: string | null;
            };
        };
    }>;
}
