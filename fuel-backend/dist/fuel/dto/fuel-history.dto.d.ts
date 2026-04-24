export declare enum FuelIntervalEnum {
    ONE_MIN = "1min",
    FIVE_MIN = "5min",
    FIFTEEN_MIN = "15min",
    HOUR = "hour",
    DAY = "day"
}
export declare class FuelHistoryDto {
    from: string;
    to: string;
    interval?: FuelIntervalEnum;
    tz?: string;
}
