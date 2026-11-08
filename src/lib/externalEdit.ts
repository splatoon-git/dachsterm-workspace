/** A row of `edit_list`, read by the file panel and by the save card on a terminal tab. */
export type ExternalEdit = {
  id: string;
  connectionId: string;
  profileId: string;
  uploadMode: string;
  remote: string;
  local: string;
  status: string;
  message: string;
  /** Whether the connection the edit is bound to is still open. */
  connectionLive: boolean;
};
