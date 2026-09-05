import { createSocialImageResponse } from "@/lib/og/create-social-image";

export async function GET() {
  return createSocialImageResponse({
    title: "Blog",
  });
}
