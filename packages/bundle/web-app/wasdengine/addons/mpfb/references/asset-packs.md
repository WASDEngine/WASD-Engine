# MakeHuman system assets

MakeHuman's system assets pack (CC0, no credit needed) is installed with MPFB; `wasd_addons.assets("mpfb")` returns its folder, which holds one folder per asset type and one folder per asset inside it. Pass the paths below to `HumanService.add_mhclo_asset` (`.mhclo`, or `.proxy` for proxies) or `HumanService.set_character_skin` (`.mhmat`), with the asset type in parentheses.

- **Proxies** (`Proxymeshes`, `proxymeshes/<name>/<name>.proxy`): `proxy741` (low-poly, 1,460 triangles), `female_generic`, `male_generic`, `female1605`, `male1591`, `female_muscle_13442`, `male_muscle_13290`.
- **Skins** (`skins/<name>/<name>.mhmat`): `young_`, `middleage_`, and `old_` followed by `african_`, `asian_`, or `caucasian_` and `female` or `male`, such as `young_asian_female`; also `young_caucasian_female2` and `toon01`, among 23.
- **Eyes** (`Eyes`): `eyes/low-poly/low-poly.mhclo` (172 triangles) and `eyes/high-poly/high-poly.mhclo`; their colors are `.mhmat` files in `eyes/materials/`.
- **Eyebrows** (`Eyebrows`): `eyebrow001` to `eyebrow012`. **Eyelashes** (`Eyelashes`): `eyelashes01` to `eyelashes04`.
- **Hair** (`Hair`): `afro01`, `bob01`, `bob02`, `braid01`, `long01`, `ponytail01`, `short01` to `short04`.
- **Teeth** (`Teeth`): `teeth_base`, `teeth_shape01` to `teeth_shape05`. **Tongue** (`Tongue`): `tongue01`.
- **Clothes** (`Clothes`): `male_casualsuit01` to `male_casualsuit06`, `male_elegantsuit01`, `male_worksuit01`, `female_casualsuit01`, `female_casualsuit02`, `female_elegantsuit01`, `female_sportsuit01`, `shoes01` to `shoes06`, `fedora01`, `fedora_cocked`.

List what is there with `sorted(os.listdir(os.path.join(wasd_addons.assets("mpfb"), "hair")))`, for example.
