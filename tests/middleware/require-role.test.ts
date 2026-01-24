import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireRole } from '../../src/http/middleware/require-role.js';
import '../setup.js';

describe('requireRole Middleware', () => {
  const mockResponse = {} as Response;
  const mockNext = vi.fn() as NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should allow access when user has the required role', () => {
    const mockRequest = {
      user: { id: 'test-id', role: 'admin' },
    } as unknown as Request;

    const middleware = requireRole('admin');
    middleware(mockRequest, mockResponse, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockNext).toHaveBeenCalledWith();
  });

  it('should deny access when user lacks the required role', () => {
    const mockRequest = {
      user: { id: 'test-id', role: 'user' },
    } as unknown as Request;

    const middleware = requireRole('admin');

    expect(() => {
      middleware(mockRequest, mockResponse, mockNext);
    }).toThrow('Insufficient permissions');

    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should deny access when user has no role', () => {
    const mockRequest = {
      user: { id: 'test-id' },
    } as unknown as Request;

    const middleware = requireRole('admin');

    expect(() => {
      middleware(mockRequest, mockResponse, mockNext);
    }).toThrow('Insufficient permissions');

    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should deny access when there is no user', () => {
    const mockRequest = {} as Request;

    const middleware = requireRole('admin');

    expect(() => {
      middleware(mockRequest, mockResponse, mockNext);
    }).toThrow('Insufficient permissions');

    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should allow access when user has one of multiple allowed roles', () => {
    const mockRequest = {
      user: { id: 'test-id', role: 'editor' },
    } as unknown as Request;

    const middleware = requireRole('admin', 'editor');
    middleware(mockRequest, mockResponse, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockNext).toHaveBeenCalledWith();
  });

  it('should deny access when user role is not in allowed roles list', () => {
    const mockRequest = {
      user: { id: 'test-id', role: 'user' },
    } as unknown as Request;

    const middleware = requireRole('admin', 'editor');

    expect(() => {
      middleware(mockRequest, mockResponse, mockNext);
    }).toThrow('Insufficient permissions');

    expect(mockNext).not.toHaveBeenCalled();
  });
});
