export interface Env {
  APP_ORIGIN: string;
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  EMAIL_API_URL?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OPENAI_CLIENT_ID?: string;
  OPENAI_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_API_URL?: string;
  BILLING_MODE?: string;
}
