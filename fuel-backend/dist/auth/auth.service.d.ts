import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { DriverLoginDto, LoginDto } from './dto/login.dto';
export declare function hashPassword(plain: string): string;
export declare class AuthService {
    private readonly dataSource;
    private readonly jwtService;
    private readonly logger;
    constructor(dataSource: DataSource, jwtService: JwtService);
    login(dto: LoginDto): Promise<{
        token: string;
        expiresIn: string;
    }>;
    driverLogin(dto: DriverLoginDto): Promise<{
        token: string;
        expiresIn: string;
        driver: {
            driverId: number;
            name: string | null;
        };
    }>;
}
