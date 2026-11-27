/**
 * Public half of the release signing key (Ed25519, SPKI DER). A client installs an update only when the
 * download manifest entry is signed with the private half, which never leaves the release machine; a
 * compromised download site therefore cannot push code to computers. Rotating it needs one manual install.
 */
export const RELEASE_PUBLIC_KEY = "MCowBQYDK2VwAyEAwpWTUTexm8IZIThPz/557MziuL+PLFDscj/CUrRmDJw=";
