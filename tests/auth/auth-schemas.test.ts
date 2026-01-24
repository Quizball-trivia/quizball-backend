import { describe, it, expect } from 'vitest';
import {
  socialLoginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resetPasswordHeadersSchema,
  registerSchema,
  loginSchema,
} from '../../src/modules/auth/auth.schemas.js';
import '../setup.js';

describe('Auth Schemas', () => {
  describe('socialLoginSchema - Open Redirect Prevention', () => {
    it('should accept valid redirect URL to localhost:3000', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'http://localhost:3000/callback',
      });

      expect(result.success).toBe(true);
    });

    it('should accept valid redirect URL to localhost:8000', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'http://localhost:8000/auth/callback',
      });

      expect(result.success).toBe(true);
    });

    it('should accept valid redirect URL to quizball.app', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'https://quizball.app/oauth/callback',
      });

      expect(result.success).toBe(true);
    });

    it('should accept valid redirect URL to www.quizball.app', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'apple',
        redirect_to: 'https://www.quizball.app/auth',
      });

      expect(result.success).toBe(true);
    });

    it('should reject redirect URL to unauthorized domain', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'https://evil.com/phishing',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Redirect URL must be to an allowed domain'
        );
      }
    });

    it('should reject redirect URL to similar-looking domain', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'https://quizball.app.evil.com/callback',
      });

      expect(result.success).toBe(false);
    });

    it('should reject redirect URL with different port on localhost', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'http://localhost:9999/callback',
      });

      expect(result.success).toBe(false);
    });

    it('should reject invalid URL format', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });

    it('should reject javascript: protocol', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'javascript:alert(1)',
      });

      expect(result.success).toBe(false);
    });

    it('should validate provider enum', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'invalid_provider',
        redirect_to: 'http://localhost:3000/callback',
      });

      expect(result.success).toBe(false);
    });

    it('should accept all valid providers', () => {
      const providers = ['google', 'apple', 'facebook', 'github'];

      for (const provider of providers) {
        const result = socialLoginSchema.safeParse({
          provider,
          redirect_to: 'http://localhost:3000/callback',
        });
        expect(result.success).toBe(true);
      }
    });

    it('should accept optional scopes as string', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'http://localhost:3000/callback',
        scopes: 'email profile',
      });

      expect(result.success).toBe(true);
    });

    it('should accept optional scopes as array', () => {
      const result = socialLoginSchema.safeParse({
        provider: 'google',
        redirect_to: 'http://localhost:3000/callback',
        scopes: ['email', 'profile'],
      });

      expect(result.success).toBe(true);
    });
  });

  describe('forgotPasswordSchema - Open Redirect Prevention', () => {
    it('should accept valid email without redirect_to', () => {
      const result = forgotPasswordSchema.safeParse({
        email: 'user@example.com',
      });

      expect(result.success).toBe(true);
    });

    it('should accept valid email with allowed redirect_to', () => {
      const result = forgotPasswordSchema.safeParse({
        email: 'user@example.com',
        redirect_to: 'http://localhost:3000/reset-password',
      });

      expect(result.success).toBe(true);
    });

    it('should reject unauthorized redirect_to domain', () => {
      const result = forgotPasswordSchema.safeParse({
        email: 'user@example.com',
        redirect_to: 'https://evil.com/steal-token',
      });

      expect(result.success).toBe(false);
    });

    it('should reject invalid email format', () => {
      const result = forgotPasswordSchema.safeParse({
        email: 'not-an-email',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('resetPasswordSchema', () => {
    it('should accept valid password (8+ characters)', () => {
      const result = resetPasswordSchema.safeParse({
        new_password: 'securepassword123',
      });

      expect(result.success).toBe(true);
    });

    it('should reject password shorter than 8 characters', () => {
      const result = resetPasswordSchema.safeParse({
        new_password: 'short',
      });

      expect(result.success).toBe(false);
    });

    it('should accept exactly 8 characters', () => {
      const result = resetPasswordSchema.safeParse({
        new_password: '12345678',
      });

      expect(result.success).toBe(true);
    });

    it('should NOT accept access_token in body (header only)', () => {
      // Verify that access_token is not part of the schema
      const result = resetPasswordSchema.safeParse({
        new_password: 'securepassword123',
        access_token: 'some-token',
      });

      // Zod strict mode would fail, but by default extra keys are stripped
      // The important thing is access_token is NOT in the parsed result
      if (result.success) {
        expect(result.data).not.toHaveProperty('access_token');
      }
    });
  });

  describe('resetPasswordHeadersSchema', () => {
    it('should accept valid Bearer token', () => {
      const result = resetPasswordHeadersSchema.safeParse({
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept Bearer token case-insensitively', () => {
      const result = resetPasswordHeadersSchema.safeParse({
        authorization: 'bearer some-token-value',
      });

      expect(result.success).toBe(true);
    });

    it('should accept BEARER token (uppercase)', () => {
      const result = resetPasswordHeadersSchema.safeParse({
        authorization: 'BEARER some-token-value',
      });

      expect(result.success).toBe(true);
    });

    it('should reject missing authorization header', () => {
      const result = resetPasswordHeadersSchema.safeParse({});

      expect(result.success).toBe(false);
    });

    it('should reject empty authorization header', () => {
      const result = resetPasswordHeadersSchema.safeParse({
        authorization: '',
      });

      expect(result.success).toBe(false);
    });

    it('should reject authorization without Bearer prefix', () => {
      const result = resetPasswordHeadersSchema.safeParse({
        authorization: 'Basic dXNlcjpwYXNz',
      });

      expect(result.success).toBe(false);
    });

    it('should reject Bearer without token', () => {
      const result = resetPasswordHeadersSchema.safeParse({
        authorization: 'Bearer ',
      });

      expect(result.success).toBe(false);
    });

    it('should reject Bearer with only whitespace', () => {
      const result = resetPasswordHeadersSchema.safeParse({
        authorization: 'Bearer    ',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('registerSchema', () => {
    it('should accept valid email and password', () => {
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'securepassword123',
      });

      expect(result.success).toBe(true);
    });

    it('should reject invalid email', () => {
      const result = registerSchema.safeParse({
        email: 'invalid-email',
        password: 'securepassword123',
      });

      expect(result.success).toBe(false);
    });

    it('should reject short password', () => {
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'short',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('loginSchema', () => {
    it('should accept valid email and password', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
        password: 'anypassword',
      });

      expect(result.success).toBe(true);
    });

    it('should reject empty password', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
        password: '',
      });

      expect(result.success).toBe(false);
    });
  });
});
