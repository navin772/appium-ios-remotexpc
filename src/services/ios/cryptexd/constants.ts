/** Identifier the DeveloperDiskImage cryptex is installed under. */
export const DDI_CRYPTEX_IDENTIFIER = 'com.apple.MobileAsset.DDI';

/** Suffix of the `Info.Variant` of the one build identity in a DDI manifest that describes a cryptex. */
export const CRYPTEX1_VARIANT_SUFFIX = 'Developer Disk Image Cryptex';

/** Values Xcode sends when installing the DDI cryptex. */
export const CRYPTEX_INSTALL_DEFAULTS = {
  clientVersion: 3,
  imageTypeIndex: 10,
  persistence: 2,
  noncePersistence: 1,
  auth: 0,
} as const;

/** Installing pushes the whole image before the device verifies and mounts it. */
export const CRYPTEX_INSTALL_TIMEOUT_MS = 120_000;
