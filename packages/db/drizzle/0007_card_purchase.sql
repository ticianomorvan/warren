ALTER TABLE "account_identifier" DROP CONSTRAINT "account_identifier_scheme";--> statement-breakpoint
ALTER TABLE "movement" DROP CONSTRAINT "movement_type";--> statement-breakpoint
ALTER TABLE "movement" ADD COLUMN "card_last_four" text;--> statement-breakpoint
ALTER TABLE "account_identifier" ADD CONSTRAINT "account_identifier_scheme" CHECK ("account_identifier"."scheme" in ('cbu','bank-label','card-last-four'));--> statement-breakpoint
ALTER TABLE "movement" ADD CONSTRAINT "movement_type" CHECK ("movement"."type" in ('own_transfer','unclassified','card_purchase'));