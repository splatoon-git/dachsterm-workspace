import { fileTypeOf } from './fileType';
import { Icon } from './Icon';
import './fileTypeIcon.css';

/** What kind of file a name is, at a glance. Decoration: the name beside it says the same. */
export function FileTypeIcon({ name }: { name: string }) {
  const type = fileTypeOf(name);
  return (
    <span
      className="file-type-icon"
      data-file-type={type.id}
      data-tone={type.tone}
      data-glyph={type.glyph}
      aria-hidden="true"
    >
      {type.icon && <Icon name={type.icon} size={14} />}
    </span>
  );
}
