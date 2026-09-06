import "server-only";
import { createDensioClient } from "./client";

export const densioApi = () =>
  createDensioClient(process.env.DENSIO_API_URL ?? "http://localhost:3000");
