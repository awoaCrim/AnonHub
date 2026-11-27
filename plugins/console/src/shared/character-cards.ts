import type { RoleCardPictures, RoleCardText } from "@yesimbot/contracts/role-cards";

export type CardFields = RoleCardText;

export interface CardEntry {
  id: string;
  name: string;
  error?: boolean;
  /** Full editable content, so opening the editor needs no extra request. */
  fields?: CardFields;
  /** The file of each picture the card has; a new picture is a new name. */
  pictures?: RoleCardPictures;
  etag?: string;
}

export interface CardsSnapshot {
  revision: string;
  active: string;
  cards: CardEntry[];
  selected?: { id: string; etag: string; fields: CardFields; pictures: RoleCardPictures };
  /** Cards that ship with the system; adding one puts a copy in the library. */
  presets: Array<{ id: string; name: string }>;
}
