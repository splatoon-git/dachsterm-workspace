# DachsTerm 마스코트

기존 `lh-dachs/assets/source`의 투명 PNG 두 개를 그대로 반입했다. 원본의 외형·화풍·크림색은 변경하지 않는다. 런타임 및 아이콘 재생성은 이 저장소의 원본만 사용한다.

**제작 경위:** GPT 이미지 생성으로 만들었다(2026-11-07 사용자 확인). 생성 이미지는 저작권 보호와 배타적 권리가 불확실하므로, 다른 사람의 유사 이미지 사용을 저작권으로 막을 수 있다고 전제하지 않는다. 상업 이용 전에 해당 서비스 약관을 확인한다.

`npm run icons`: Sharp로 투명 PNG, 다중 크기 ICO, ICNS 생성. 48px 미만은 얼굴, 이상은 전신. 화면에서는 32px 얼굴과 100/156px 전신을 사용한다. 원본 체크무늬 reference 이미지는 사용하지 않는다.

## 모험 전용 동작 atlas (G.4 / 2026-11-05)

`dachshund-adventure-atlas.png`: 내장 image_gen 도구로 `dachshund-full.png`를 외형·화풍 참조로 생성. 1536×1024 RGBA, 512×512 셀의 3열×2행. 원본 두 파일을 대체하지 않는다. 순서: 서기 / 달리기 A / 달리기 B / 점프 / 물기 / 피격. SVG viewBox로 셀을 표시하고 방향 반전·프레임 전환은 게임 상태에서 계산한다. 실제 alpha 확인(0~254), 외부 파일 경로에 런타임 의존하지 않는다.

최종 생성 프롬프트(내장 도구, `transparent_background: true`):

> Use case: stylized-concept. Asset type: production sprite atlas for a side-scrolling game. Reference image 1 is the character identity and rendering style reference, not an image to reproduce in a sitting pose. Create ONE transparent PNG sprite sheet, exactly 3 columns by 2 rows of equal sized cells, 1536x1024 canvas. SIX full-body poses of the SAME long-haired cream dachshund facing RIGHT in side profile, keeping its beautiful cream coat, long floppy silky ears, long low dachshund body, short legs, gentle dark eyes, and painterly detailed original style. No clothes or accessories. Keep identical scale across all cells, body fills about 80% of each cell width, paws on common baseline 85% down each cell. Each pose entirely within its cell, with ample transparent spacing. Row1 col1: idle STANDING on four short legs in right-facing side profile. Row1 col2: run stride with front legs reaching forward and rear legs backward, ears trailing. Row1 col3: run opposite stride legs tucked under body. Row2 col1: jump airborne front paws tucked, ears floating. Row2 col2: playful bite attack, head lunging forward, open jaws with small teeth, legs braced. Row2 col3: hurt recoil slightly crouched backwards, ears lifted, no injury or blood. Clean consistent professional game animation atlas. Genuinely transparent background, no backgrounds, no ground, no shadows, no panels, no text, no labels, no grid lines, no extra characters.

G.5 간식 타임도 같은 atlas와 `DachsSprite.tsx`를 공유한다. 물기 포즈는 간식 씹기, 점프 포즈는 별 획득 반응으로 재사용하며 별도 이미지 생성/수정은 없다.
