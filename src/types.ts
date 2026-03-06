import { z } from "zod";

export const formFieldsSchema = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(3).optional(),
  company: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  postalCode: z.string().min(1).optional(),
});
export type FormFields = z.infer<typeof formFieldsSchema>;
