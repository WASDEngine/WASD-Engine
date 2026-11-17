/**
 * The marks of the platforms the Export / Share dialog builds for, drawn in the text color around them, as the WASD
 * Engine site draws the marks of its download buttons: Windows as four panes, macOS and iOS as the Apple logo, the Web
 * as the HTML5 logo, and Android as the Android robot, each in a 24-unit frame. The Apple, HTML5, and Android paths are
 * Simple Icons' `apple`, `html5`, and `android` (simple-icons 16.31.0, CC0-1.0). Microsoft, Apple Inc., the W3C, and
 * Google own the marks, which here name the platform a build runs on. The HTML5 logo is the W3C's, licensed under
 * Creative Commons Attribution 3.0; the Android robot is reproduced or modified from work created and shared by Google
 * and used according to terms described in the Creative Commons 3.0 Attribution License.
 */
import type { ExportPlatform } from './ExportShareButton.tsx'

/** The Apple logo, which marks both Apple platforms. */
const APPLE = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'

/** Each platform's mark as one path in a 24-unit frame. */
export const PLATFORM_LOGO_PATHS: Readonly<Record<ExportPlatform, string>> = {
  windows: 'M0 0h11.4v11.4H0zm12.6 0H24v11.4H12.6zM0 12.6h11.4V24H0zm12.6 0H24V24H12.6z',
  macos: APPLE,
  web: 'M1.5 0h21l-1.91 21.563L11.977 24l-8.564-2.438L1.5 0zm7.031 9.75l-.232-2.718 10.059.003.23-2.622L5.412 4.41l.698 8.01h9.126l-.326 3.426-2.91.804-2.955-.81-.188-2.11H6.248l.33 4.171L12 19.351l5.379-1.443.744-8.157H8.531z',
  android: 'M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z',
  ios: APPLE,
}

/**
 * Render one platform's mark, decorative beside the platform's name.
 * @param props.platform - the platform.
 * @param props.size - rendered edge in pixels.
 * @param props.className - placement and color of the mark, which takes `currentColor`.
 * @returns the mark's svg.
 */
export function PlatformLogo({ platform, size, className }: {
  readonly platform: ExportPlatform
  readonly size: number
  readonly className?: string | undefined
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true" data-platform-logo={platform}>
      <path d={PLATFORM_LOGO_PATHS[platform]} />
    </svg>
  )
}
