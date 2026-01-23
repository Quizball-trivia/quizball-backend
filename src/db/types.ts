import type { Database, Json } from './database.types.js';

// Extract table types for convenience
export type User = Database['public']['Tables']['users']['Row'];
export type UserInsert = Database['public']['Tables']['users']['Insert'];
export type UserUpdate = Database['public']['Tables']['users']['Update'];

export type UserIdentity = Database['public']['Tables']['user_identities']['Row'];
export type UserIdentityInsert = Database['public']['Tables']['user_identities']['Insert'];

// Identity with user joined
export type IdentityWithUser = UserIdentity & { user: User };

// Category types
export type Category = Database['public']['Tables']['categories']['Row'];
export type CategoryInsert = Database['public']['Tables']['categories']['Insert'];
export type CategoryUpdate = Database['public']['Tables']['categories']['Update'];

// Question types
export type Question = Database['public']['Tables']['questions']['Row'];
export type QuestionInsert = Database['public']['Tables']['questions']['Insert'];
export type QuestionUpdate = Database['public']['Tables']['questions']['Update'];

// Question payload types
export type QuestionPayload = Database['public']['Tables']['question_payloads']['Row'];
export type QuestionPayloadInsert = Database['public']['Tables']['question_payloads']['Insert'];
export type QuestionPayloadUpdate = Database['public']['Tables']['question_payloads']['Update'];

// Question with payload joined
export type QuestionWithPayload = Question & { payload: Json | null };

// Featured category types
export type FeaturedCategory = Database['public']['Tables']['featured_categories']['Row'];
export type FeaturedCategoryInsert = Database['public']['Tables']['featured_categories']['Insert'];
export type FeaturedCategoryUpdate = Database['public']['Tables']['featured_categories']['Update'];

// Featured category with category joined
export type FeaturedCategoryWithCategory = FeaturedCategory & { category: Category };

// i18n type for JSONB fields
export type I18nField = Record<string, string>;

// Re-export Json type
export type { Json };
