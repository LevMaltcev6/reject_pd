export type Mode = "withdrawal" | "inquiry";
export type DeliveryMode = "draft" | "send";
export interface Company {
  id: string;
  name: string;
  emails: string[];
  sourceStatus: string;
  notes: string;
  special: string | null;
  withdrawalExtra: string;
  legalName?: string;
  inn?: string;
  ogrn?: string;
}
export interface Profile {
  fio: string;
  email: string;
  inn: string;
  phone: string;
  series: string;
  number: string;
  issuer: string;
  city: string;
  issued: string;
  date: string;
}
export interface Template {
  subject: string;
  body: string;
}
export interface Letter {
  companyId: string;
  companyName: string;
  to: string[];
  subject: string;
  body: string;
  missing: string[];
  actions: string[];
}
export interface Account {
  useCurrentSession?: true;
  uid?: string;
  provider: "gmail" | "yandex";
  email: string;
  baseUrl: string;
}
export type Status =
  | "queued"
  | "opening"
  | "waiting"
  | "sending"
  | "sent"
  | "filled"
  | "manual"
  | "error"
  | "uncertain";
export interface Item {
  id: string;
  letter: Letter;
  status: Status;
  error?: string;
  attempted?: boolean;
  rejected?: boolean;
}
