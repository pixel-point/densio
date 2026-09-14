import { customAlphabet } from "nanoid";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generateId = customAlphabet(alphabet, 21);
const generateOrganizationId = customAlphabet(alphabet, 12);

// Keep lengths fixed at the boundary so call sites cannot reduce collision resistance.
export const createId = () => generateId();
export const createOrganizationId = () => generateOrganizationId();
