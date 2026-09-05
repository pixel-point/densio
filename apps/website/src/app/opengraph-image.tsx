import config from "@/configs/website-config";
import {
  createSocialImageResponse,
  resolveHomeSocialTitle,
  SOCIAL_IMAGE_CONTENT_TYPE,
  SOCIAL_IMAGE_SIZE,
} from "@/lib/og/create-social-image";

export const alt = `${config.projectName} social preview`;
export const size = SOCIAL_IMAGE_SIZE;
export const contentType = SOCIAL_IMAGE_CONTENT_TYPE;

export default async function OpengraphImage() {
  return createSocialImageResponse({
    title: await resolveHomeSocialTitle(),
  });
}
