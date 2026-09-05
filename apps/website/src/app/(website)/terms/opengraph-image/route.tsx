import { createSocialImageResponse } from "@/lib/og/create-social-image";

const SOCIAL_IMAGE_TITLE = "Terms & Conditions | densio";

export async function GET() {
  return createSocialImageResponse({
    title: SOCIAL_IMAGE_TITLE,
  });
}
