import { Response } from 'express';

export class ResponseHandler {
  public static success(res: Response, data: any, message: string = 'Success', statusCode: number = 200): Response {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
      timestamp: Date.now()
    });
  }

  public static error(res: Response, message: string = 'Error occurred', statusCode: number = 400, errors: any = null): Response {
    return res.status(statusCode).json({
      success: false,
      message,
      errors,
      timestamp: Date.now()
    });
  }
}
