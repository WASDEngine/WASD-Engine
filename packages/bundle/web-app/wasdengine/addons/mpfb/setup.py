"""Point MPFB at the MakeHuman system assets that WASD Engine installs with it, as MPFB's preferences panel does."""
import importlib

import bpy


def setup(module, assets):
    """Make the asset pack MPFB's second asset root and load MPFB's asset lists from it."""
    bpy.context.preferences.addons[module].preferences.mpfb_second_root = assets
    services = importlib.import_module(module + '.services')
    services.LocationService.update_second_root()
    services.AssetService.update_all_asset_lists()
