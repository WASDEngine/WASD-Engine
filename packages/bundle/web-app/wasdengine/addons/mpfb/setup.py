"""Point MPFB at the MakeHuman system assets that WASD Engine installs with it, as MPFB's preferences panel does, and
offer the module wasd_mpfb: human() makes a dressed human whose face looks natural in a game, add_face() gives it a
face that a game can move, and export() writes it as a .glb."""
import importlib
import math
import os
import random
import sys
import types
import zlib

import bpy
import numpy as np

# Each face shape as what the face's muscles do in it, which _form() turns into the shape. Lengths are millimeters on
# a head whose pupils are 62 mm apart, and scale with the head; angles are degrees.
#   jaw      how far the jaw opens, about its hinge
#   pull     the mouth's corners drawn (to the side, back, up), as a smile draws them
#   sink     the mouth's corners drawn (to the side, down)
#   stretch  the mouth's corners drawn (to the side, back, down), flat across the teeth
#   purse    the lips gathered: the mouth's corners drawn (inward), its middle (forward), and the lips' edges (down),
#            the upper lip's over the teeth and the lower lip's half as far
#   narrow   the corners of an open mouth drawn inward
#   lift     the upper lip's edge lifted off the teeth
#   drop     the lower lip's edge lowered
#   push     the lower lip pushed (up, forward) by the chin, and the chin's pad with it
#   thin     the lips drawn thinner, as shares of the (upper, lower) lip's height
#   cheeks   the cheeks' flesh under the eyes lifted (to the side, forward, up)
#   nostrils the nose's wings drawn (to the side, up)
#   fold     how deep the skin folds beside the nose and the mouth's corners, where a cheek that lifts meets a lip
#            that does not
#   brows    the brows' (inner ends up, outer ends up, inner ends toward the nose, inner ends forward)
#   lids     the (upper lid down, lower lid up) of both eyes, or of one eye as {'l': ...}, for eyes as wide open as
#            most are: narrower eyes take less
#   shut     the eyes that close, 'l', 'r', or 'lr': the upper lid comes down to the lower lid's edge all along it
#   lean     how much of the face's own lean to one side the shape takes: no feeling sits evenly on a face
# The amounts are taken off faces, not off the names of feelings: a smile widens the mouth by a fifth and lifts its
# corners in a curve that is flat in the middle, it thins the lips, lifts the cheeks, and the cheeks lift the lower
# lids, without which a smile is a mask's; a grin's teeth show because the lip thins and lifts over them, the lower
# lip's edge following the teeth's; sadness is the brows' inner ends, a mouth whose corners sink, and a chin that
# pushes the lower lip up; anger is brows drawn down and together over lids that tighten; an open mouth is the jaw's
# turn, which takes the lower teeth with it and leaves the upper lip where it is.
FACE_SHAPES = {
    'blink_l': {'shut': 'l'},
    'blink_r': {'shut': 'r'},
    # The mouth of speech: an "ah", an "oo", and an "ee", each as wide as speech makes it, not as a shout does.
    'mouth_open': {'jaw': 11.0, 'narrow': 2.5, 'lift': 2.6},
    'mouth_narrow': {'jaw': 2.2, 'purse': (6.5, 3.0, 1.2), 'thin': (-0.04, -0.04)},
    'mouth_wide': {'jaw': 1.2, 'pull': (3.0, 1.6, 1.2), 'lift': 2.2, 'drop': 1.8, 'thin': (0.15, 0.08)},
    # A smile keeps the lips together; a grin parts them over the upper teeth. Both lift the cheeks under the eyes.
    'smile': {'pull': (5.0, 3.6, 6.2), 'thin': (0.22, 0.08), 'cheeks': (1.2, 2.2, 3.2), 'nostrils': (0.5, 0.4), 'fold': 0.6,
              'lids': (1.0, 10.0), 'lean': 1.0},
    'grin': {'jaw': 1.8, 'pull': (6.0, 4.4, 7.2), 'lift': 5.5, 'drop': 0.8, 'thin': (0.32, 0.1), 'cheeks': (1.8, 3.0, 4.5),
             'nostrils': (0.8, 0.6), 'fold': 1.0, 'lids': (3.0, 13.0), 'lean': 0.5},
    'sad': {'sink': (1.0, 5.2), 'push': (2.5, 1.0), 'brows': (7.5, -0.5, 2.5, 0.0), 'lids': (5.0, 0.0), 'lean': 0.6},
    'angry': {'sink': (0.8, 2.5), 'push': (1.6, 0.5), 'thin': (0.45, 0.4), 'nostrils': (1.2, 0.6), 'brows': (-6.5, -2.5, 3.5, 1.8),
              'lids': (4.0, 10.0), 'lean': 0.5},
    'surprised': {'jaw': 9.0, 'narrow': 2.5, 'lift': 2.2, 'brows': (9.5, 9.5, 0.0, 0.0), 'lids': (-13.0, 0.0), 'lean': 0.3},
    'afraid': {'jaw': 4.0, 'stretch': (4.0, 2.8, 1.2), 'lift': 2.0, 'drop': 1.5, 'thin': (0.15, 0.1), 'nostrils': (0.8, 0.3),
               'brows': (8.0, 4.0, 3.0, 0.0), 'lids': (-13.0, 4.0), 'lean': 0.4},
    'disgusted': {'jaw': 0.5, 'lift': 4.5, 'sink': (0.5, 1.5), 'push': (1.2, 0.5), 'cheeks': (0.5, 1.2, 2.5), 'nostrils': (1.0, 3.5),
                  'fold': 1.0, 'brows': (-4.5, -1.5, 2.8, 1.2), 'lids': (0.0, 12.0), 'lean': 1.5},
    'brows_up': {'brows': (6.0, 6.0, 0.0, 0.0)},
    'brows_down': {'brows': (-4.5, -1.8, 2.5, 1.2)},
    'squint': {'lids': (7.0, 13.0)},
}

# MakeHuman's base mesh, by vertex: the upper lip's midline vertex on the ring of vertices where the lips meet and on
# the seven rings round it, and on the two rings inside the mouth; the left eye's rings from its lid margin outward,
# by the vertex of each above the middle of the eye, and the next vertex of the lid margin's ring; the nose's ridge
# from the lip to between the brows; the chin's pad; and the cheekbones. The mouth's rings have 38 vertices and the
# eye's 28, each ring's vertices in line with the next ring's, as spokes.
LIP_RINGS = (474, 468, 509, 467, 466, 455, 362, 5342)
MOUTH_RINGS = (520, 537)
EYE_RINGS = (6784, 11466, 6786, 6788, 11514, 6873, 6929, 6946, 6952)
LID_EDGE = (6784, 6785)
# The first edge of the line of vertices round the lips' rings, from under the lower lip's middle, past the left
# corner of the mouth, to the nose's left wing: where a chin creases under a lip that it pushes up, and where a
# cheek folds beside a mouth that smiles.
FOLD_EDGE = (724, 7446)
NOSE_RIDGE = (317, 312, 307, 302, 297, 5054, 294, 5134, 291, 201, 164, 5063, 131, 135, 134, 133, 132, 136)
CHIN_PAD = (5162, 5211, 5171, 5225, 5296, 732, 747, 780, 991)
CHEEKBONES = (11704, 5089)

# The bones of MakeHuman's own rig, whose painted weights MPFB ships, that hang on the jaw; the bones of the cheeks;
# and the bones of the head, by the start of their names.
JAW_BONES = ('jaw', 'special04', 'oris01', 'oris02', 'oris06.L', 'oris06.R', 'oris07.L', 'oris07.R', 'tongue00', 'tongue01',
             'tongue02', 'tongue03', 'tongue04', 'tongue05.L', 'tongue05.R', 'tongue06.L', 'tongue06.R', 'tongue07.L', 'tongue07.R')
CHEEK_BONES = ('risorius03.L', 'risorius03.R', 'levator05.L', 'levator05.R')
HEAD_BONES = ('head', 'jaw', 'levator', 'oculi', 'orbicularis', 'oris', 'risorius', 'special', 'temporalis')

# The parts that MPFB fits to the face, by its object types; hair and clothes keep their shape.
FACE_PARTS = ('Proxymeshes', 'Eyelashes', 'Eyebrows', 'Teeth', 'Tongue')

# The two rows of teeth that the base mesh carries as helper geometry, by their vertex groups.
TEETH_ROWS = ('helper-upper-teeth', 'helper-lower-teeth')

# The tongue that the base mesh carries as helper geometry, by its vertex group.
TONGUE = 'helper-tongue'

# The materials of the mouth's inside, by the end of their names: base color, roughness, and metallic. No sky shines
# into a mouth: the pocket is metallic and rough, which leaves it no shine of its own, only its dark color where
# light falls, and the teeth and the tongue are rough. The names avoid "teeth" and "tongue", by which a game's
# material fix-up, such as WasdSurface.human, would take them for MPFB's own and polish them.
MOUTH_MATERIALS = {
    'mouth_dark': ((0.033, 0.006, 0.006, 1.0), 1.0, 1.0),
    'mouth_white': ((0.34, 0.29, 0.19, 1.0), 0.8, 0.0),
    'mouth_pink': ((0.3, 0.07, 0.07, 1.0), 0.6, 0.0),
}

# Each eye color: the iris near the pupil, at its rim, and the ring round the pupil, as sRGB.
EYE_COLORS = {
    'brown': ((0.45, 0.285, 0.15), (0.24, 0.14, 0.07), (0.56, 0.37, 0.18)),
    'dark': ((0.33, 0.215, 0.14), (0.17, 0.105, 0.065), (0.42, 0.27, 0.16)),
    'hazel': ((0.47, 0.38, 0.16), (0.27, 0.27, 0.13), (0.62, 0.42, 0.14)),
    'green': ((0.40, 0.49, 0.27), (0.17, 0.29, 0.17), (0.60, 0.50, 0.22)),
    'blue': ((0.42, 0.52, 0.63), (0.16, 0.26, 0.39), (0.62, 0.63, 0.58)),
    'gray': ((0.56, 0.61, 0.65), (0.28, 0.33, 0.38), (0.68, 0.66, 0.58)),
}

# Each hair color, as the sRGB color of hair in even light.
HAIR_COLORS = {
    'black': (0.115, 0.105, 0.1),
    'dark': (0.16, 0.115, 0.09),
    'brown': (0.24, 0.165, 0.12),
    'auburn': (0.36, 0.18, 0.11),
    'red': (0.52, 0.25, 0.13),
    'blonde': (0.68, 0.55, 0.36),
    'gray': (0.54, 0.54, 0.53),
    'white': (0.86, 0.86, 0.84),
}

# The face's landmarks on MakeHuman's base mesh, by vertex, on the character's left and on its midline: the eye's
# inner and outer corner, the corner of the mouth, the nose's wing, the widest point of the cheek before the ear,
# the crown, the lowest point under the chin, the line where the lips meet, the upper and the lower edge of the
# lips' red, where the nose meets the upper lip, the chin's front, the front of the upper and of the lower lip, each
# as the foremost of two vertices, two thirds of the way from the mouth's middle to its corner, the upper edge of the
# upper lip's red and the lower edge of the lower lip's, each with the vertex of the line where the lips meet that
# it lies over or under, the widest point of the jaw below the mouth, and the side of the chin.
MARKS = {'en': 6850, 'ex': 6805, 'ch': 7192, 'al': 7102, 'zy': 12362, 'top': 881, 'under': 787, 'sto': 474, 'ls': 362,
         'li': 492, 'sn': 317, 'pg': 5162, 'up': 455, 'up2': 466, 'low': 495, 'low2': 496,
         'us': 11943, 'us0': 7225, 'ld': 7166, 'ld0': 7230, 'go': 7459, 'cw': 11779}

# What a face measures when it reads as good-looking, for a (woman, man) of each of MakeHuman's three groups, in
# millimeters: the head from crown to under the chin, between the pupils, between the eyes' inner corners and
# between their outer corners, across the mouth, the nose's wings, the cheeks before the ears, the jaw below the
# mouth, and the chin, from where the lips meet to under the chin, the height of the red of the upper and of the
# lower lip in the mouth's middle, how far the mouth's corners lie above the middle of the line where the lips
# meet, and how far the upper lip, the lower lip, and the chin stand out past the point where the nose meets the
# lip, seen from the side; in degrees, how far the eyes' outer corners stand above their inner ones; and how much
# of the iris's upper half the upper lid covers, which is what tells a rested eye from a tired one and from a
# stare. The lengths are those of young adults' faces as they are measured, each group's own, with the eyes a few
# percent larger and the cheeks a few percent narrower, which is where faces rated good-looking differ from the
# average one, the lower lip a third higher than the upper, which is how the lips rated best are, and a woman's jaw
# seven tenths as wide as her cheeks over a small chin, where a man's is three quarters as wide over a broad one.
# MakeHuman's own faces fall well short of them: their eyes are a twentieth too small on faces a twentieth too
# wide, and a tenth too near each other, their mouths are a sixth too narrow and hang two mm at the corners, their
# chins lie a centimeter behind their lips, their women have a man's jaw, their men a chin half a centimeter too
# long, and their upper lids hang over nearly half of the iris's upper half.
CANON = {
    'caucasian': {'height': (216.0, 230.5), 'pupils': (62.0, 64.5), 'inner': (31.0, 32.5), 'outer': (88.5, 91.5), 'mouth': (49.5, 52.5),
                  'nose': (29.5, 34.5), 'cheeks': (132.0, 138.0), 'jaw': (93.0, 106.0), 'chin': (33.0, 41.0), 'chin_tall': (42.5, 49.5),
                  'upper_lip': (8.0, 7.2), 'lower_lip': (10.4, 9.6), 'corner': (0.3, 0.0), 'upper_out': (2.5, 2.0),
                  'lower_out': (-1.5, -2.0), 'chin_out': (-5.5, -4.0), 'tilt': (5.0, 3.5), 'lid': (0.25, 0.33)},
    'asian': {'height': (214.0, 228.0), 'pupils': (62.5, 64.5), 'inner': (35.5, 37.5), 'outer': (88.5, 91.5), 'mouth': (48.5, 51.5),
              'nose': (32.5, 36.5), 'cheeks': (134.5, 141.5), 'jaw': (94.5, 108.0), 'chin': (32.0, 40.0), 'chin_tall': (42.5, 49.0),
              'upper_lip': (9.0, 8.2), 'lower_lip': (10.8, 10.0), 'corner': (0.3, 0.0), 'upper_out': (2.6, 2.6),
              'lower_out': (-0.8, -0.8), 'chin_out': (-5.5, -4.5), 'tilt': (8.5, 7.5), 'lid': (0.31, 0.38)},
    'african': {'height': (216.0, 231.0), 'pupils': (63.5, 66.0), 'inner': (33.0, 34.5), 'outer': (91.0, 94.0), 'mouth': (51.5, 54.5),
                'nose': (36.0, 41.0), 'cheeks': (132.0, 139.0), 'jaw': (93.0, 107.0), 'chin': (33.0, 41.0), 'chin_tall': (42.5, 49.5),
                'upper_lip': (10.6, 9.8), 'lower_lip': (12.8, 12.2), 'corner': (0.3, 0.0), 'upper_out': (4.5, 3.8),
                'lower_out': (2.8, 1.6), 'chin_out': (-5.5, -4.5), 'tilt': (6.0, 4.5), 'lid': (0.25, 0.33)},
}

# How high the red of the (upper, lower) lip is two thirds of the way from the mouth's middle to its corner, as a
# share of its height in the middle: lips taper to the corners, the upper one from the peaks of its bow, and lips
# that keep their height to the corners are two bands.
LIP_SIDES = (0.55, 0.6)

# How much of each measure of CANON one face may differ from the next: as a share of it, or, for the measures that
# may be nothing, as it is, in mm or in degrees.
OWN = {'height': 0.025, 'pupils': 0.03, 'inner': 0.03, 'outer': 0.02, 'mouth': 0.05, 'nose': 0.06, 'cheeks': 0.03, 'jaw': 0.03,
       'chin': 0.08, 'chin_tall': 0.04, 'upper_lip': 0.08, 'lower_lip': 0.08, 'corner': 0.3, 'upper_out': 0.5, 'lower_out': 0.5,
       'chin_out': 1.0, 'tilt': 1.2, 'lid': 0.0}
AS_IT_IS = ('corner', 'upper_out', 'lower_out', 'chin_out', 'tilt', 'lid')

# The handles that bring a face to its measures: each what lessens something and what adds to it, with how much the
# handle resists being used and the most of either. A handle goes one way or the other, never both: a target and its
# opposite do not quite cancel, and a face that has both in full is bent by what is left. Most are MakeHuman's
# detail targets, in which {s} stands for both sides and an eye's first corner is its outer one. The eyes' size is
# this script's own: MakeHuman's target opens the lids wider over an eyeball that stays as small, which leaves a
# dark gap beside it, and its narrower head shrinks the eyeballs with the head. An eye grows whole here, its ball,
# its iris, and its lids together, by a sixth at most, and shrinks by an eighth at most. An eye's corners go in and
# out by themselves besides, which sets the iris where it sits between them: nearer the outer corner, where
# MakeHuman's men have it nearer the inner one. The outer corner goes out by little: further out it would stand off
# the ball. The lips' red grows and shrinks whole, which keeps how it tapers to the mouth's corners, and its middle
# and its sides by themselves besides: MakeHuman's own targets for a lip's height move its middle alone, and what
# they leave of full lips is a band. The jaw has two handles, its bone and the head's outline, which share the work.
EYES_LARGER, EYES_SMALLER = 'own/eyes-larger', 'own/eyes-smaller'
HANDLES = {
    'eye_size': (EYES_SMALLER, EYES_LARGER, 0.02, (0.65, 0.65)),
    'eye_apart': ('eyes/{s}-eye-trans-in', 'eyes/{s}-eye-trans-out', 0.02, (1.0, 1.0)),
    'outer_corner': ('eyes/{s}-eye-corner1-down', 'eyes/{s}-eye-corner1-up', 0.02, (1.0, 1.0)),
    'inner_corner': ('eyes/{s}-eye-corner2-up', 'eyes/{s}-eye-corner2-down', 0.3, (0.6, 0.6)),
    'outer_reach': ('eyes/{s}-eye-push1-in', 'eyes/{s}-eye-push1-out', 0.1, (0.8, 0.25)),
    'inner_reach': ('eyes/{s}-eye-push2-in', 'eyes/{s}-eye-push2-out', 0.1, (0.5, 0.8)),
    'mouth': ('mouth/mouth-scale-horiz-decr', 'mouth/mouth-scale-horiz-incr', 0.02, (1.0, 1.0)),
    'corner': ('mouth/mouth-angles-down', 'mouth/mouth-angles-up', 0.02, (0.6, 0.9)),
    'lips': ('mouth/mouth-scale-vert-decr', 'mouth/mouth-scale-vert-incr', 0.05, (0.9, 0.6)),
    'upper_lip': ('mouth/mouth-upperlip-middle-down', 'mouth/mouth-upperlip-middle-up', 0.1, (0.6, 0.6)),
    'lower_lip': ('mouth/mouth-lowerlip-height-decr', 'mouth/mouth-lowerlip-height-incr', 0.1, (0.6, 0.6)),
    'upper_side': ('mouth/mouth-upperlip-ext-down', 'mouth/mouth-upperlip-ext-up', 0.05, (1.0, 0.5)),
    'lower_side': ('mouth/mouth-lowerlip-ext-down', 'mouth/mouth-lowerlip-ext-up', 0.05, (1.0, 0.5)),
    'lips_out': ('mouth/mouth-trans-backward', 'mouth/mouth-trans-forward', 0.1, (0.5, 0.5)),
    'upper_out': ('mouth/mouth-upperlip-volume-decr', 'mouth/mouth-upperlip-volume-incr', 0.1, (0.6, 0.6)),
    'lower_out': ('mouth/mouth-lowerlip-volume-decr', 'mouth/mouth-lowerlip-volume-incr', 0.1, (0.6, 0.6)),
    'chin_out': ('chin/chin-prominent-decr', 'chin/chin-prominent-incr', 0.05, (0.8, 0.8)),
    'jaw': ('chin/chin-bones-decr', 'chin/chin-bones-incr', 0.05, (1.0, 0.6)),
    'jaw_line': ('head/head-diamond', 'head/head-square', 0.15, (0.6, 0.3)),
    'chin': ('chin/chin-width-decr', 'chin/chin-width-incr', 0.05, (0.9, 0.5)),
    'chin_tall': ('chin/chin-height-decr', 'chin/chin-height-incr', 0.05, (0.5, 0.3)),
    'nose': ('nose/nose-scale-horiz-decr', 'nose/nose-scale-horiz-incr', 0.05, (0.8, 0.8)),
    'head_wide': ('head/head-scale-horiz-decr', 'head/head-scale-horiz-incr', 0.1, (0.6, 0.6)),
    'head_tall': ('head/head-scale-vert-decr', 'head/head-scale-vert-incr', 0.1, (0.5, 0.5)),
}

# How much each measure counts when a face is brought to its measures.
COUNTS = {'height': 0.1, 'pupils': 1.0, 'inner': 1.0, 'outer': 1.0, 'rise': 3.0, 'mouth': 1.0, 'nose': 0.3, 'cheeks': 0.5,
          'jaw': 0.5, 'chin': 0.5, 'chin_tall': 0.5, 'upper_lip': 1.0, 'lower_lip': 1.0, 'upper_side': 1.0, 'lower_side': 0.7,
          'corner': 2.0, 'upper_out': 0.6, 'lower_out': 0.6, 'chin_out': 0.5}

# What else makes a face of MakeHuman's read as good-looking, as detail targets with how much of each at looks=1: no
# bags under the eyes, an upper lip with a bow, and cheekbones that stand out and sit high, with a plane under them
# for a light to break on: without them a face is one sheet from eye to jaw. A woman has a nose with a fine tip and a
# slim neck besides, and keeps most of her cheeks' flesh, since a woman's face that is as lean as a man's is gaunt
# in a game's light. The jaw and the chin are set by the face's measures.
STYLE = {
    'female': {
        'eyes/{s}-eye-bag-decr': 1.0, 'eyes/{s}-eye-bag-in': 0.5, 'mouth/mouth-cupidsbow-incr': 0.3,
        'nose/nose-point-up': 0.15, 'nose/nose-point-width-decr': 0.35, 'nose/nose-volume-decr': 0.25, 'nose/nose-width2-decr': 0.2,
        'cheek/{s}-cheek-bones-incr': 0.45, 'cheek/{s}-cheek-trans-up': 0.35, 'cheek/{s}-cheek-volume-decr': 0.08,
        'chin/chin-triangle': 0.2, 'head/head-fat-decr': 0.15, 'neck/neck-scale-horiz-decr': 0.35, 'ears/{s}-ear-wing-decr': 0.3,
    },
    'male': {
        'eyes/{s}-eye-bag-decr': 1.0, 'eyes/{s}-eye-bag-in': 0.5, 'mouth/mouth-cupidsbow-incr': 0.15,
        'nose/nose-hump-decr': 0.3, 'cheek/{s}-cheek-volume-decr': 0.1, 'cheek/{s}-cheek-bones-incr': 0.45,
        'cheek/{s}-cheek-trans-up': 0.2, 'head/head-fat-decr': 0.25, 'ears/{s}-ear-wing-decr': 0.4,
    },
}

# The features in which one face differs from the next beside its measures: each a detail target and its opposite,
# with the most of each that a seed may draw. A face may differ more toward what suits it than away from it: a nose
# may be finer by more than it may be longer or humped. Two humans of one kind are then two people, and neither is
# the plainer for it.
FEATURES = (
    ('nose/nose-scale-vert-decr', 'nose/nose-scale-vert-incr', 0.3, 0.2), ('nose/nose-hump-decr', 'nose/nose-hump-incr', 0.3, 0.08),
    ('nose/nose-point-down', 'nose/nose-point-up', 0.1, 0.2), ('nose/nose-width2-decr', 'nose/nose-width2-incr', 0.3, 0.15),
    ('nose/nose-curve-concave', 'nose/nose-curve-convex', 0.25, 0.12), ('nose/nose-base-up', 'nose/nose-base-down', 0.2, 0.2),
    ('head/head-oval', 'head/head-round', 0.3, 0.2), ('forehead/forehead-temple-decr', 'forehead/forehead-temple-incr', 0.3, 0.3),
    ('cheek/{s}-cheek-volume-decr', 'cheek/{s}-cheek-volume-incr', 0.3, 0.1), ('cheek/{s}-cheek-bones-decr', 'cheek/{s}-cheek-bones-incr', 0.1, 0.3),
    ('eyes/{s}-eye-eyefold-down', 'eyes/{s}-eye-eyefold-up', 0.3, 0.3),
    ('eyebrows/eyebrows-trans-down', 'eyebrows/eyebrows-trans-up', 0.25, 0.3), ('eyebrows/eyebrows-angle-down', 'eyebrows/eyebrows-angle-up', 0.2, 0.3),
    ('ears/{s}-ear-wing-decr', 'ears/{s}-ear-wing-incr', 0.3, 0.0),
)

# An iris's radius as a share of its eyeball's, and the most of it in mm on a face whose pupils are 62 mm apart: an
# eye that has grown to its measures keeps an iris of a size that irises have, and a larger one is a doll's. And how
# much of the iris's lower half the lower lid covers.
IRIS = 0.375
IRIS_MOST = 6.15
LOWER_LID = 0.12

# What keeps a face from being its own mirror image, which no face is: MakeHuman's targets that shift one side of
# the brows, the lids, the mouth, the nose, the jaw, and the cheeks, each with the most of it that a seed may draw,
# for one side or the other. They move a face by a mm at most.
LOPSIDED = (('asym/asym-brown-1', 0.12), ('asym/asym-eye-5', 0.5), ('asym/asym-eye-7', 0.5), ('asym/asym-mouth-1', 0.1),
            ('asym/asym-mouth-2', 0.08), ('asym/asym-nose-1', 0.15), ('asym/asym-nose-3', 0.15), ('asym/asym-jaw-1', 0.15),
            ('asym/asym-jaw-2', 0.12), ('asym/asym-cheek-1', 0.15))

# The corners of a mouth at rest are drawn (to the side, back, up) by this much, in mm, as a face that is at ease
# holds them, and the cheeks with them: on a mouth whose corners the face's measures have set level it is the hint
# of a smile. Three times as much is a smirk.
AT_EASE = (0.3, 0.15, 0.5)

# The words in a hair asset's name that tell of curls, which take light as a mass and not in a band across strands.
CURLY = ('afro', 'curl', 'dread', 'braid')

# What a human wears and carries on its head unless told otherwise, by gender; and the hair of those of MakeHuman's
# groups whose hair is not straight.
DEFAULTS = {
    'female': {'hair': 'long01', 'lashes': 'eyelashes02', 'outfit': ('female_casualsuit01', 'shoes01')},
    'male': {'hair': 'short02', 'lashes': 'eyelashes01', 'outfit': ('male_casualsuit01', 'shoes02')},
}
GROUP_HAIR = {'african': {'female': 'afro01', 'male': 'short01'}}

# The eyebrow asset whose cards a face's own brows are painted on: the widest of MakeHuman's, from just over the lid
# to well up the forehead.
BROW_CARD = 'eyebrow012'

# An eyebrow's line and its thickness for a (woman, man), in mm on a face whose pupils are 62 mm apart: where it
# starts, past the eye's inner corner toward the nose, where it peaks, short of the eye's outer corner, and where
# it ends, past that corner; and its middle line's height over the eye's middle and its thickness at its start,
# over the pupil, at its peak, and at its end. A woman's brow is finer, stands higher over the eye, and arches; a
# man's is heavier, lower, and straighter.
BROW_SPAN = ((1.0, 2.5), (3.0, 5.0), (9.5, 7.5))
BROW_HEIGHTS = ((16.8, 11.8), (19.2, 13.4), (21.0, 14.4), (17.4, 12.2))
BROW_THICKNESS = ((6.6, 8.0), (6.8, 7.6), (5.2, 5.8), (1.4, 1.8))

# How far hair stands off the skull at the crown and at the sides for a (woman, man), in mm on a face whose pupils
# are 62 mm apart, and the share of it for hair that is worn tight or that has its own volume, by a word of its
# asset's name.
HAIR_LIFT = ((16.0, 9.0), (11.0, 4.0))
HAIR_TIGHT = {'afro': 0.3, 'ponytail': 0.45, 'braid': 0.45}

# What a skin picture's middle color may be for a game's lights, as linear luminance and as saturation (the share of
# its strongest channel that its weakest lacks). MakeHuman painted its skins for its own flat preview: under a sun
# its light skins burn out to a pale pink, and its dark skins, darker and far redder than skin is, turn to rust.
SKIN_LIGHTEST = 0.4
SKIN_DARKEST = 0.085
SKIN_PALEST = 0.36
SKIN_DEEPEST = 0.52


def setup(module, assets):
    """Make the asset pack MPFB's second asset root, load MPFB's asset lists from it, and register wasd_mpfb."""
    bpy.context.preferences.addons[module].preferences.mpfb_second_root = assets
    services = importlib.import_module(module + '.services')
    services.LocationService.update_second_root()
    services.AssetService.update_all_asset_lists()
    helper = types.ModuleType('wasd_mpfb', 'WASD Engine\'s helpers for MPFB humans: human(), add_face(body), and export(body, path).')
    helper.FACE_SHAPES = dict(FACE_SHAPES)
    helper.EYE_COLORS = tuple(EYE_COLORS)
    helper.HAIR_COLORS = tuple(HAIR_COLORS)
    helper.human = lambda gender='female', age=25, ethnicity='caucasian', **options: human(module, assets, gender, age, ethnicity, **options)
    helper.human.__doc__ = human.__doc__
    helper.add_face = lambda body, shapes=None, eye_bones=True: add_face(module, body, shapes, eye_bones)
    helper.add_face.__doc__ = add_face.__doc__
    helper.export = lambda body, path, texture_size=1024: export(module, body, path, texture_size)
    helper.export.__doc__ = export.__doc__
    sys.modules['wasd_mpfb'] = helper


def human(module, assets, gender='female', age=25, ethnicity='caucasian', *, looks=1.0, seed=0, build=None, skin=None,
          eyes='brown', hair=None, hair_color=None, brows=None, lashes=None, makeup=None, outfit=None, detail='high',
          rig='game_engine'):
    """Make a dressed human with a good-looking face that looks natural in a game, and return its base mesh; its
    parent is the rig.

    gender is 'female' or 'male' (or MakeHuman's 0 to 1), age is in years from 12, and ethnicity is 'caucasian',
    'asian', or 'african' (or their shares as a dict). looks, from 0 to 1, is how far the face is brought to what
    good-looking faces of its kind measure: eyes of the right size and distance, open and a little tilted, a mouth
    as wide as mouths are, with lips that taper to corners that lie level, cheekbones, and a jaw and a chin to match;
    0 leaves MakeHuman's own plain face, and a half suits a face in a crowd. seed draws the features in which this face differs from others
    of its kind; None draws none. build sets MakeHuman's body values, such as
    {'muscle': 0.7, 'weight': 0.4, 'height': 0.6}.
    eyes is a name of EYE_COLORS, hair a hair asset's name or False, hair_color a name of HAIR_COLORS or an sRGB
    color, lashes an asset's name or False, and outfit the names of clothes assets; what is left out follows the
    gender. brows left out are painted for this face, full and in its hair's color: an eyebrow asset's name takes
    that asset's picture instead, and False leaves the face without. makeup, from 0 to 1, is how groomed the face is:
    lashes that line the lids, color on the lips and the cheeks, and brows drawn clean; left out, a woman's is a
    half and a man's none. skin names a skin asset; left out, it follows gender, age, and ethnicity.

    detail 'high' keeps MakeHuman's own head, with teeth and a tongue, for a human seen up close: follow it with
    add_face(). 'low' is a human for a crowd or the distance: the 1,460-triangle proxy without brows, lashes, or
    teeth, whose face is too coarse to be seen up close or to move.
    """
    services = importlib.import_module(module + '.services')
    people, targets = services.HumanService, services.TargetService
    male = gender == 'male' if isinstance(gender, str) else float(gender) >= 0.5
    kind = 'male' if male else 'female'
    if isinstance(gender, str) and gender not in ('female', 'male'):
        raise ValueError('gender is "female" or "male", or a number from 0 (female) to 1 (male).')
    if eyes not in EYE_COLORS:
        raise ValueError(f'Unknown eye color {eyes!r}; the colors are {", ".join(EYE_COLORS)}.')
    if isinstance(hair_color, str) and hair_color not in HAIR_COLORS:
        raise ValueError(f'Unknown hair color {hair_color!r}; the colors are {", ".join(HAIR_COLORS)}, or give an sRGB color.')
    if detail not in ('high', 'low'):
        raise ValueError('detail is "high" or "low".')
    races = {'asian': 0.0, 'caucasian': 0.0, 'african': 0.0}
    if isinstance(ethnicity, str):
        if ethnicity not in races:
            raise ValueError(f'Unknown ethnicity {ethnicity!r}; it is "caucasian", "asian", or "african", or their shares as a dict.')
        races[ethnicity] = 1.0
    else:
        total = sum(float(share) for share in ethnicity.values()) or 1.0
        for name, share in ethnicity.items():
            if name not in races:
                raise ValueError(f'Unknown ethnicity {name!r}; the shares are of "caucasian", "asian", and "african".')
            races[name] = float(share) / total
    years = max(12.0, min(float(age), 90.0))
    macro = targets.get_default_macro_info_dict()
    macro.update(
        gender=(1.0 if male else 0.0) if isinstance(gender, str) else float(gender),
        # MakeHuman's age runs from a child of ten at 0.1875 over a young adult of twenty-five at 0.5 to ninety at 1.
        age=0.1875 + (years - 10.0) / 15.0 * 0.3125 if years < 25.0 else 0.5 + (years - 25.0) / 65.0 * 0.5,
        race=races, muscle=0.55, weight=0.45, proportions=0.5 + 0.4 * looks)
    macro.update(build or {})
    body = people.create_human(macro_detail_dict=macro)
    # The face's own shape goes on before the rig and the parts, which are fitted to the body as it then is. The
    # body's shape so far becomes its rest shape: the face is measured and shaped as it stands.
    if targets.has_any_shapekey(body):
        targets.bake_targets(body)
    manly = float(macro['gender'])
    # What makes a face good-looking is taken back by half on an old one, which is to stay old: its lids hang a
    # little, its lips are thinner, and the skin under its eyes is not a child's.
    aged = float(_ease(40.0, 75.0, years))
    lid = _shape_face(services, body, kind, manly, races, looks, seed, aged) + 0.14 * aged
    groom = min(max(0.5 * (1.0 - manly) if makeup is None else float(makeup), 0.0), 1.0)
    # No two skins are of one tone: this one is a little lighter or darker than its kind's, and warmer by more than
    # it may be cooler, since a face with a little gold and red in it is a healthy one and a cool one is pale.
    tone = random.Random(1000003 * seed + 17) if seed is not None else None
    tone = (1.0 + 0.06 * tone.uniform(-1.0, 1.0), tone.uniform(-0.3, 1.0)) if tone is not None else (1.0, 0.35)
    lids = None
    if detail == 'high':
        # The head closes its lips at rest, and tells where the upper lids' edges are and the ring of skin next to them,
        # and which of the vertices that MakeHuman counts among the lips lie in the groove under the lower lip: its
        # seventh ring, between the mouth's corners.
        head = _Head(body, _rig_weights(services), _mirrors(services))
        lids = {'mouth': head.rings[0], 'under_lip': head.rings[6][13:26]}
        for side in 'lr':
            rings = head.eye_rings[side]
            upper = head.lid_weights[side, 'upper'][rings[0]] > head.lid_weights[side, 'lower'][rings[0]]
            # The upper lid's edge and the ring next to it, the lower lid's edge, and the lid's crease, which is the
            # fifth ring, where the lid meets the skin under the brow, with the rings beside it.
            lids[side] = {'edge': rings[0][upper], 'next': rings[1][upper], 'lower': rings[0][~upper], 'crease': rings[4][upper],
                          'beside': np.concatenate([rings[3][upper], rings[5][upper]])}
        if looks > 0.0:
            # A face at ease holds its mouth its own way: with more or less of that hint of a smile, and with more of
            # it on one side. Eight faces that rest alike are one face eight times.
            ease = random.Random(7919 * seed + 3) if seed is not None else None
            _rest_face(head, lid, looks, (ease.uniform(0.5, 1.5), ease.uniform(0.0, 3.5)) if ease is not None else (1.0, 0.0))
    people.add_builtin_rig(body, rig)

    def part(folder, name, sort):
        path = os.path.join(assets, folder, name, name + ('.proxy' if sort == 'Proxymeshes' else '.mhclo'))
        if not os.path.exists(path):
            there = ', '.join(sorted(os.listdir(os.path.join(assets, folder))))
            raise ValueError(f'No {folder} asset {name!r}; there are {there}.')
        return people.add_mhclo_asset(path, body, asset_type=sort, subdiv_levels=0)

    stage = 'young' if years < 40.0 else 'middleage' if years < 62.0 else 'old'
    skin = skin or f'{stage}_{max(races, key=races.get)}_{kind}'
    material = os.path.join(assets, 'skins', skin, skin + '.mhmat')
    if not os.path.exists(material):
        raise ValueError(f'No skin asset {skin!r}; there are {", ".join(sorted(os.listdir(os.path.join(assets, "skins"))))}.')
    if detail == 'low':
        part('proxymeshes', 'proxy741', 'Proxymeshes')
    people.set_character_skin(material, body, skin_type='GAMEENGINE', material_instances=False)
    for mesh in [body, *_fitted(services, body, ('Proxymeshes',))]:
        for slot in mesh.material_slots:
            _tone_skin(_own_picture(slot.material))
    balls = part('eyes', 'low-poly' if detail == 'low' else 'high-poly', 'Eyes')
    _natural_eyes(balls, eyes)
    wear = DEFAULTS[kind]
    tint = HAIR_COLORS[hair_color] if isinstance(hair_color, str) else hair_color
    card = None
    if detail == 'high':
        if brows is None:
            # The widest of MakeHuman's eyebrow cards, for this face's own brows, which are painted once its hair
            # has told their color.
            card = part('eyebrows', BROW_CARD, 'Eyebrows')
        elif brows:
            picture = _own_picture(part('eyebrows', brows, 'Eyebrows').material_slots[0].material)
            _recolor(picture, None if tint is None else _brow_color(tint))
        lashes = wear['lashes'] if lashes is None else lashes
        if lashes:
            fringe = part('eyelashes', lashes, 'Eyelashes')
            _recolor(_own_picture(fringe.material_slots[0].material), None)
            _taper_lashes(fringe, balls, min(0.8 + 0.4 * groom, 1.0))
        teeth = part('teeth', 'teeth_base', 'Teeth')
        _whiten(_own_picture(teeth.material_slots[0].material))
        _shade_mouth([teeth, part('tongue', 'tongue01', 'Tongue')])
    hair = GROUP_HAIR.get(max(races, key=races.get), {}).get(kind, wear['hair']) if hair is None else hair
    locks = part('hair', hair, 'Hair') if hair else None
    # A bald head keeps MakeHuman's stubble, in the hair's color where one was given.
    roots = tint
    if locks is not None:
        picture = _own_picture(locks.material_slots[0].material)
        _recolor(picture, tint)
        roots = tint or _middle_color(picture)
        # A name with "hair" in it, by which a game's material fix-up, such as WasdSurface.human, knows what it holds.
        locks.material_slots[0].material.name = f'{body.name}.hair_{hair}'
        # Curls lie every way: no band of light runs across them.
        locks['wasd_straight'] = 0.0 if any(word in hair for word in CURLY) else 1.0
        _hang_hair(locks)
        full = next((share for word, share in HAIR_TIGHT.items() if word in hair), 1.0)
        _lift_hair(locks, body, *(full * (pair[0] * (1.0 - manly) + pair[1] * manly) for pair in HAIR_LIFT))
    for name in (wear['outfit'] if outfit is None else outfit):
        part('clothes', name, 'Clothes')
    if card is not None:
        _paint_brows(card, body, _mirrors(services), manly, _brow_color(roots or HAIR_COLORS['dark']), groom, seed, 1.0 - 0.2 * aged)
    if detail == 'high':
        # MakeHuman's East Asian lids have no brow bone over them to fold under: their crease is faint.
        _finish_skin(body, [locks] if locks is not None else [], roots, lids, groom, tone, 1.0 - 0.7 * races['asian'])
    return body


def _shape_face(services, body, kind, manly, races, looks, seed, aged=0.0):
    """Give a human's face its features and bring it to the measures of a good-looking face, by MakeHuman's detail
    targets, on a body whose shape is its rest shape. The style of its kind goes on as far as looks says, and the
    features that the seed draws; then the handles are set to what brings the face's measures as near to its canon
    as they reach, which also undoes what the style and the features did to those measures; and last the seed draws
    what makes one side of the face differ from the other. manly is 0 for a woman and 1 for a man, races the shares
    of MakeHuman's three groups, and aged 0 for a face under forty and 1 for one over seventy-five. Returns how much
    of the iris's upper half the face's upper lids are to cover."""
    import gzip
    rest = _coords(body)
    root = os.path.join(os.path.dirname(services.__file__), '..', 'data', 'targets')
    properties = importlib.import_module(services.__name__.rsplit('.', 1)[0] + '.entities.objectproperties').GeneralObjectProperties
    scale = float(properties.get_value('scale_factor', entity_reference=body) or 1.0)
    # MakeHuman counts in decimeters.
    mm = scale * 0.01
    fields = {}

    def field(name):
        """A target's vertices and how far it moves each, in the body's own axes and units."""
        if name in (EYES_LARGER, EYES_SMALLER) and name not in fields:
            # Everything within 19 mm of an eye's middle grows or shrinks about it, and what lies beyond gives way
            # over the next 11 mm: the nose's root and the temples stay where they are.
            moves = np.zeros_like(rest)
            for side in 'lr':
                ball = rest[_in_group(body, f'helper-{side}-eye')]
                away = rest - ball.mean(axis=0)
                near = 1.0 - _ease(19.0 * mm, 30.0 * mm, np.linalg.norm(away, axis=1))
                moves += away * near[:, None] * (0.25 if name == EYES_LARGER else -0.125)
            index = np.flatnonzero(np.abs(moves).max(axis=1) > 0.0)
            fields[name] = (index, moves[index])
        if name not in fields:
            index, moves = [], []
            for side in (('l', 'r') if '{s}' in name else ('',)):
                with gzip.open(os.path.join(root, name.replace('{s}', side) + '.target.gz'), 'rt', encoding='utf-8') as file:
                    for line in file:
                        row = line.split()
                        if len(row) >= 4 and row[0].isdigit() and int(row[0]) < len(rest):
                            index.append(int(row[0]))
                            moves.append((float(row[1]), -float(row[3]), float(row[2])))
            fields[name] = (np.array(index, dtype=int), np.array(moves).reshape(-1, 3) * scale)
        return fields[name]

    def add(name, weight):
        index, moves = field(name)
        np.add.at(rest, index, moves * weight)

    used = {}
    for name, weight in (STYLE[kind].items() if looks > 0.0 else ()):
        # An old face keeps half of the bags under its eyes.
        used[name] = weight * looks * (1.0 - 0.5 * aged if 'eye-bag' in name else 1.0)
    if looks > 0.0:
        # An old face that is good to look at has kept the flesh of its cheeks, which MakeHuman's old have lost.
        used['cheek/{s}-cheek-volume-incr'] = 0.35 * aged * looks
    draw = random.Random(seed)
    if seed is not None:
        for less, more, most_less, most_more in FEATURES:
            share = draw.uniform(-1.0, 1.0)
            name, amount = (more, share * most_more) if share > 0.0 else (less, -share * most_less)
            used[name] = used.get(name, 0.0) + amount
    for name, weight in used.items():
        add(name, min(weight, 1.0))
    blend = lambda pair: pair[0] * (1.0 - manly) + pair[1] * manly
    canon = {name: sum(share * blend(CANON[race][name]) for race, share in races.items()) for name in OWN}
    for name in ('upper_lip', 'lower_lip'):
        canon[name] *= 1.0 - 0.12 * aged
    if looks <= 0.0:
        _set_coords(body, rest)
        return canon['lid']

    # The face is measured by a few vertices: its marks on both sides, and the eyeballs' helper vertices.
    mirrors = _mirrors(services)
    balls = [np.array(_in_group(body, f'helper-{side}-eye'), dtype=int) for side in 'lr']
    marks = {name: (index, mirrors.get(index, index)) for name, index in MARKS.items()}
    watch = sorted({int(index) for pair in marks.values() for index in pair} | {int(index) for ball in balls for index in ball})
    row = {index: at for at, index in enumerate(watch)}
    rows = {name: (row[left], row[right]) for name, (left, right) in marks.items()}
    ball_rows = [np.array([row[int(index)] for index in ball]) for ball in balls]

    def measures(points):
        centers = [points[rows_of].mean(axis=0) for rows_of in ball_rows]
        at = lambda name, side=0: points[rows[name][side]]
        wide = lambda name: at(name)[0] - at(name, 1)[0]
        return {'pupils': (centers[0][0] - centers[1][0]) / mm, 'inner': wide('en') / mm, 'outer': wide('ex') / mm,
                'rise': (at('ex')[2] - at('en')[2] + at('ex', 1)[2] - at('en', 1)[2]) / 2.0 / mm,
                'mouth': wide('ch') / mm, 'nose': wide('al') / mm, 'cheeks': wide('zy') / mm, 'jaw': wide('go') / mm,
                'chin': wide('cw') / mm, 'chin_tall': (at('sto')[2] - at('under')[2]) / mm,
                'height': (at('top')[2] - at('under')[2]) / mm, 'upper_lip': (at('ls')[2] - at('sto')[2]) / mm,
                'lower_lip': (at('sto')[2] - at('li')[2]) / mm,
                'upper_side': (at('us')[2] - at('us0')[2]) / mm, 'lower_side': (at('ld0')[2] - at('ld')[2]) / mm,
                'corner': (at('ch')[2] - at('sto')[2]) / mm,
                # The human faces -Y: what stands out further has the lesser Y.
                'upper_out': (at('sn')[1] - min(at('up')[1], at('up2')[1])) / mm,
                'lower_out': (at('sn')[1] - min(at('low')[1], at('low2')[1])) / mm, 'chin_out': (at('sn')[1] - at('pg')[1]) / mm}

    def watched(name):
        index, moves = field(name)
        moved = np.zeros((len(watch), 3))
        for vertex, move in zip(index, moves):
            if int(vertex) in row:
                moved[row[int(vertex)]] += move
        return moved

    points = rest[watch]
    now = measures(points)
    own = {name: (draw.uniform(-1.0, 1.0) if seed is not None else 0.0) * most for name, most in OWN.items()}
    # A larger head has larger features.
    size = 1.0 + own['height']
    wanted = {name: canon[name] + own[name] if name in AS_IT_IS else canon[name] * (1.0 + own[name]) * (1.0 if name == 'height' else size)
              for name in OWN if name not in ('tilt', 'lid')}
    wanted['rise'] = math.tan(math.radians(canon['tilt'] + own['tilt'])) * (wanted['outer'] - wanted['inner']) / 2.0
    wanted['upper_side'], wanted['lower_side'] = wanted['upper_lip'] * LIP_SIDES[0], wanted['lower_lip'] * LIP_SIDES[1]
    wanted = {name: now[name] + looks * (value - now[name]) for name, value in wanted.items()}
    names = [(handle, side) for handle in HANDLES for side in (0, 1)]
    moved = [watched(HANDLES[handle][side]) for handle, side in names]
    hold = np.array([HANDLES[handle][2] for handle, _ in names])
    most = np.array([HANDLES[handle][3][side] for handle, side in names])
    counts = np.array([COUNTS[name] for name in wanted])
    amounts = np.zeros(len(names))
    for _ in range(2):
        here = points + sum(move * amount for move, amount in zip(moved, amounts))
        base = measures(here)
        slopes = np.array([[measures(here + move)[name] - base[name] for move in moved] for name in wanted])
        left = np.array([wanted[name] - base[name] for name in wanted])
        step = np.zeros(len(names))
        # Least squares by one handle at a time: each way of it is tried with the other way at nothing, between none
        # of it and all of it, and the way that leaves less undone is taken.
        for _ in range(120):
            for first in range(0, len(names), 2):
                pair = (first, first + 1)
                rest_of = left - slopes @ step + slopes[:, first] * step[first] + slopes[:, first + 1] * step[first + 1]
                best = None
                for at, other in (pair, pair[::-1]):
                    column = slopes[:, at]
                    # The other way is taken back whole, which this way's residue starts from.
                    open_to = rest_of + slopes[:, other] * amounts[other]
                    taken = float(np.clip((float((counts * column * open_to).sum()) - hold[at] * amounts[at])
                                          / (float((counts * column * column).sum()) + hold[at]), -amounts[at], most[at] - amounts[at]))
                    undone = float((counts * (open_to - column * taken) ** 2).sum()) + hold[at] * (amounts[at] + taken) ** 2
                    if best is None or undone < best[0]:
                        best = (undone, at, other, taken)
                _, at, other, taken = best
                step[at], step[other] = taken, -amounts[other]
        amounts += step
    for (handle, side), amount in zip(names, amounts):
        if amount > 0.004:
            add(HANDLES[handle][side], float(amount))
    if seed is not None:
        for name, most_of in LOPSIDED:
            add(f'{name}-{draw.choice("lr")}', draw.uniform(0.0, most_of))
    _set_coords(body, rest)
    return canon['lid']


def _set_coords(mesh, coords):
    """Give a mesh object's vertices their positions, and its rest shape where it has shape keys."""
    mesh.data.vertices.foreach_set('co', coords.ravel())
    if mesh.data.shape_keys is not None:
        mesh.data.shape_keys.key_blocks[0].data.foreach_set('co', coords.ravel())
    mesh.data.update()


def _rest_face(head, lid, looks, ease=(1.0, 0.0)):
    """Give a head the face of someone rested and at ease. Its lids go where an open eye has them: the upper lid
    over the share of the iris's upper half that is given, and the lower lid at the iris's lower edge. MakeHuman's
    upper lids hang over nearly half of the iris's upper half, which is what makes its faces look tired, and no
    detail target lifts an upper lid without lowering the lower one, which bares the white under the iris in a
    stare. The lids turn about their eyes, as lids do, and the skin round them follows. And the corners of its
    mouth lift by AT_EASE, times the first of ease, the face's leaning side by more as the second of ease says, as a
    face shape's lean does. The head's rest shape is the old one afterwards: it is for no further use."""
    body = head.body
    covers = (lid, LOWER_LID)
    turns = {}
    for side in 'lr':
        ball = head.rest[_in_group(body, f'helper-{side}-eye')]
        # The eye model's ball is a twentieth larger than the helper it is fitted to.
        iris = min(IRIS * 1.048 * float(np.ptp(ball, axis=0)[[0, 2]].mean()) / 2.0, IRIS_MOST * head.mm)
        edge = head.eye_rings[side][0]
        offset = head.rest[edge] - head.eyes[side]
        over = np.abs(offset[:, 0]) < 0.6 * iris
        for part, sign, cover, most in (('upper', 1.0, covers[0], (-3.0, 12.0)), ('lower', -1.0, covers[1], (-6.0, 10.0))):
            weights = head.lid_weights[side, part][edge]
            mine = over & (offset[:, 2] * sign > 0.0)
            if not mine.any():
                continue
            # The lid's edge where it stands farthest from the eye's middle line, over or under the iris.
            pick = int(np.flatnonzero(mine)[np.argmax(offset[mine][:, 2] * sign)])
            reach = math.hypot(offset[pick][1], offset[pick][2])
            stands = math.degrees(math.atan2(offset[pick][2], -offset[pick][1]))
            goes = math.degrees(math.asin(max(-1.0, min(1.0, sign * iris * (1.0 - cover) / reach))))
            # How far up the edge has to turn, a positive angle for either lid.
            up = min(max((goes - stands) / max(float(weights[pick]), 0.5), most[0]), most[1]) * looks
            turns[side, part] = -up if part == 'upper' else up
    at_ease = {'pull': tuple(amount * looks * ease[0] for amount in AT_EASE), 'lean': ease[1]}
    _set_coords(body, head.rest + head.shape(0.0, turns, {}) + _form(head, at_ease))


def _paint_brows(brows, body, mirrors, manly, color, groom, seed, full=1.0, size=1024):
    """Paint a human's eyebrows for its own face, on an eyebrow asset's cards: for each brow a line that starts over
    the eye's inner corner, rises to a peak short of its outer corner, and thins out to an end past it, as high
    over the eye and as thick as BROW_HEIGHTS and BROW_THICKNESS say for a woman and a man, a little different for
    every seed. The brow is a soft shade of its color with its hairs drawn over it, each along the way brows grow:
    up at the brow's start, and from its upper and its lower edge toward its middle line further out, where they
    run on along it. From a step away single hairs are too fine to be seen, and the shade is the brow; up close the
    hairs are. MakeHuman's own brow pictures are thin pencil lines beside it. color is the brows' sRGB color,
    groom, from 0 to 1, how clean their edges are, and full how thick they are beside those of the young."""
    import numpy
    mesh = brows.data
    spots = numpy.array([(brows.matrix_world @ vertex.co)[:] for vertex in mesh.vertices])
    rest = numpy.array([(body.matrix_world @ vertex.co)[:] for vertex in body.data.vertices])
    centers = {side: rest[_in_group(body, f'helper-{side}-eye')].mean(axis=0) for side in 'lr'}
    mm = float(numpy.linalg.norm(centers['l'] - centers['r'])) / 62.0
    blend = lambda pair: pair[0] * (1.0 - manly) + pair[1] * manly
    draw = numpy.random.default_rng(11 if seed is None else 11 + seed)
    own = draw.uniform(-1.0, 1.0, 4) if seed is not None else numpy.zeros(4)
    lift, arch, wide = 1.2 * own[0], 1.0 * own[1] + 0.4 * groom, 1.0 + 0.12 * own[2] - 0.06 * groom
    heights = [blend(pair) + lift + (arch if at == 2 else 0.0) for at, pair in enumerate(BROW_HEIGHTS)]
    thick = [blend(pair) * wide * full for pair in BROW_THICKNESS]
    alpha = numpy.zeros((size, size), dtype=numpy.float32)
    tone = numpy.ones((size, size), dtype=numpy.float32)
    for side, sign in (('l', 1.0), ('r', -1.0)):
        faces = {polygon.index for polygon in mesh.polygons if sum(spots[index][0] for index in polygon.vertices) * sign > 0.0}
        if not faces:
            continue
        eye = centers[side]
        corner = lambda name: rest[MARKS[name] if side == 'l' else mirrors.get(MARKS[name], MARKS[name])]
        # Each point of the cards by how far it lies from the face's middle and how high over the eye's, in mm.
        across, drawn = _raster(mesh, [sign * spot[0] / mm for spot in spots], size, faces)
        height, _ = _raster(mesh, [(spot[2] - eye[2]) / mm for spot in spots], size, faces)
        across, reach = _spread(across, drawn, 4)
        height, _ = _spread(height, drawn, 4)
        knots = [sign * corner('en')[0] / mm - blend(BROW_SPAN[0]), sign * eye[0] / mm,
                 sign * corner('ex')[0] / mm - blend(BROW_SPAN[1]), sign * corner('ex')[0] / mm + blend(BROW_SPAN[2])]
        # The brow's middle line and its thickness along it, as tables a quarter of a mm apart, rounded off.
        table = numpy.arange(knots[0] - 8.0, knots[3] + 8.0, 0.25)
        box = numpy.ones(17) / 17.0
        middle = numpy.convolve(numpy.pad(numpy.interp(table, knots, heights), 8, mode='edge'), box, mode='valid')
        girth = numpy.convolve(numpy.pad(numpy.interp(table, knots, thick), 8, mode='edge'), box, mode='valid')
        # The cards lie on the face's own brow ridge, which is lower on one face than on another: a brow that would
        # reach past their upper edge moves down whole, and is thinner where it would reach past their lower edge.
        place = numpy.clip(((across[drawn] - table[0]) / 0.25).astype(int), 0, len(table) - 1)
        top, bottom = numpy.full(len(table), -1e9), numpy.full(len(table), 1e9)
        numpy.maximum.at(top, place, height[drawn])
        numpy.minimum.at(bottom, place, height[drawn])
        known = top > -1e8
        if known.sum() > 8:
            top = numpy.convolve(numpy.pad(numpy.interp(table, table[known], top[known]), 8, mode='edge'), box, mode='valid')
            bottom = numpy.convolve(numpy.pad(numpy.interp(table, table[known], bottom[known]), 8, mode='edge'), box, mode='valid')
            body_of = (table > knots[0] + 3.0) & (table < knots[3] - 6.0)
            middle = middle - max(float((middle + girth * 0.5 - top + 1.2)[body_of].max()), 0.0)
            lower = numpy.maximum(middle - girth * 0.5, bottom + 0.8)
            upper = numpy.maximum(middle + girth * 0.5, lower + 1.0)
            middle, girth = (lower + upper) * 0.5, upper - lower
        slope = numpy.gradient(middle, 0.25)
        at_table = lambda values, where: numpy.interp(where, table, values)
        share = (across - knots[0]) / (knots[3] - knots[0])
        over = (height - at_table(middle, across)) / numpy.maximum(at_table(girth, across) * 0.5, 0.3)
        # How much of a brow there is at each point: all of it within its edges, the lower edge cleaner than the
        # upper, thinning out toward its start and its end.
        soft = (1.5 - 0.7 * groom, 0.8 - 0.4 * groom)
        half = at_table(girth, across) * 0.5
        full = (_smooth(-soft[0] * 0.5, soft[0] * 0.5, half - (height - at_table(middle, across)))
                * _smooth(-soft[1] * 0.5, soft[1] * 0.5, half + (height - at_table(middle, across)))
                * _smooth(knots[0] - 1.5, knots[0] + 7.0, across) * (1.0 - _smooth(knots[3] - 3.0, knots[3], across))) * reach
        # The cards run out into a point at the temple, where a brow has thinned out to nothing.
        full = full * (1.0 - _smooth(float(across[drawn].max()) - 5.0, float(across[drawn].max()) - 2.0, across))
        if float(full.sum()) < 1.0:
            continue
        # A step of one mm across the face and one up it, in pixels of the picture, at each point.
        rows_x, columns_x = numpy.gradient(_blur(across, 2))
        rows_z, columns_z = numpy.gradient(_blur(height, 2))
        turn = columns_x * rows_z - rows_x * columns_z
        turn = numpy.where(numpy.abs(turn) < 1e-6, 1e-6, turn)
        # Hairs: their roots where the brow is, more of them where there is more of it.
        area = float((full * numpy.abs(turn)).sum())
        count = int(area * (4.2 + 0.8 * manly))
        chance = (full * numpy.abs(turn)).ravel()
        picked = draw.choice(size * size, count, p=chance / chance.sum())
        row, column = (picked // size).astype(float) + draw.random(count), (picked % size).astype(float) + draw.random(count)
        shade = draw.uniform(0.6, 1.25, count)
        length = draw.uniform(0.75, 1.15, count) * (3.6 + 0.6 * manly)
        # A hair is drawn as dots a little over two pixels apart, which run together into a line.
        steps = 48
        hair = numpy.zeros((size, size), dtype=numpy.float32)
        lit, weight = numpy.zeros((size, size), dtype=numpy.float32), numpy.zeros((size, size), dtype=numpy.float32)
        for step in range(steps):
            near_row = numpy.clip(row.astype(int), 0, size - 1)
            near_column = numpy.clip(column.astype(int), 0, size - 1)
            along = share[near_row, near_column]
            above = numpy.clip(over[near_row, near_column], -1.5, 1.5)
            base = numpy.arctan(at_table(slope, across[near_row, near_column]))
            start = 1.0 - _smooth(0.05, 0.32, along)
            run = base - 0.26 * above * (1.0 - 0.6 * _smooth(0.75, 1.0, along))
            angle = run * (1.0 - start) + (1.25 - 0.25 * above) * start + draw.normal(0.0, 0.1, count)
            reach_mm = length * (1.0 - 0.35 * _smooth(0.7, 1.0, along)) * (1.0 - 0.3 * start) / steps
            ahead, up = numpy.cos(angle) * reach_mm, numpy.sin(angle) * reach_mm
            there = turn[near_row, near_column]
            right = (rows_z[near_row, near_column] * ahead - rows_x[near_row, near_column] * up) / there
            down = (-columns_z[near_row, near_column] * ahead + columns_x[near_row, near_column] * up) / there
            # Where the card turns under the brow, a mm seen from the front is many pixels: a hair goes no further
            # there in a step than elsewhere, or it would be a row of dots.
            far = numpy.maximum(numpy.hypot(right, down) / 3.0, 1.0)
            column += right / far
            row += down / far
            dark = 0.62 - 0.35 * step / steps
            width = 1.0 - 0.45 * step / steps
            for below in (-1, 0, 1):
                for beside in (-1, 0, 1):
                    spot_row = numpy.clip(numpy.round(row).astype(int) + below, 0, size - 1)
                    spot_column = numpy.clip(numpy.round(column).astype(int) + beside, 0, size - 1)
                    away = (spot_row - row) ** 2 + (spot_column - column) ** 2
                    laid = (dark * numpy.exp(-away / (2.0 * width * width))).astype(numpy.float32)
                    numpy.add.at(hair, (spot_row, spot_column), laid)
                    numpy.add.at(lit, (spot_row, spot_column), laid * shade)
                    numpy.add.at(weight, (spot_row, spot_column), laid)
        strands = 1.0 - numpy.exp(-0.9 * hair)
        under = (0.44 + 0.1 * groom) * _blur(full, 3)
        mine = ((1.0 - (1.0 - strands) * (1.0 - under)) * numpy.clip(_blur(reach.astype(numpy.float32), 3) * 2.0 - 1.0, 0.0, 1.0)
                * (1.0 - _smooth(float(across[drawn].max()) - 3.0, float(across[drawn].max()) - 1.0, across)))
        alpha = numpy.maximum(alpha, mine)
        tone = numpy.where(weight > 1e-3, 1.0 + (lit / numpy.maximum(weight, 1e-3) - 1.0) * strands, tone)
    image = bpy.data.images.new(f'{body.name}.brows', size, size, alpha=True)
    pixels = numpy.empty((size, size, 4), dtype=numpy.float32)
    pixels[..., :3] = numpy.clip(numpy.array(color[:3], dtype=numpy.float32) * tone[..., None], 0.0, 1.0)
    pixels[..., 3] = alpha
    _keep(image, pixels)
    material = brows.material_slots[0].material
    for node in material.node_tree.nodes:
        if node.type == 'TEX_IMAGE' and node.image is not None:
            node.image = image
    # A name with "brow" in it, by which a game's material fix-up, such as WasdSurface.human, knows what it holds.
    material.name = f'{body.name}.eyebrows'


def _picture_of(material):
    """The picture that colors a material: the image of the first image node that feeds its shader, or none."""
    if material is None or not material.use_nodes:
        return None
    for node in material.node_tree.nodes:
        if node.type == 'TEX_IMAGE' and node.image is not None and any(output.is_linked for output in node.outputs):
            return node.image
    return None


def _own_picture(material):
    """The picture that colors a material, made this material's alone. MPFB hands every human of a session the same
    picture of an asset, and what one human's skin, hair, or brows were made into must not be the next one's: a
    picture that a human has changed already is read from its file again."""
    if material is None or not material.use_nodes:
        return None
    for node in material.node_tree.nodes:
        if node.type == 'TEX_IMAGE' and node.image is not None and any(output.is_linked for output in node.outputs):
            image = node.image
            source = bpy.path.abspath(image.filepath) if image.filepath else ''
            if any(key.startswith('wasd_') for key in image.keys()) and os.path.isfile(source):
                node.image = bpy.data.images.load(source, check_existing=False)
                node.image.colorspace_settings.name = image.colorspace_settings.name
            return node.image
    return None


def _pixels(image):
    """A picture's pixels as rows of RGBA floats, bottom row first."""
    import numpy
    pixels = numpy.empty(image.size[0] * image.size[1] * 4, dtype=numpy.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(image.size[1], image.size[0], 4)


def _keep(image, pixels):
    """Write pixels back into a picture and keep them in the .blend, so that an export writes the changed picture."""
    image.pixels.foreach_set(pixels.ravel())
    image.update()
    image.pack()


def _light(color):
    """sRGB values as light."""
    import numpy
    return numpy.where(color <= 0.04045, color / 12.92, ((color + 0.055) / 1.055) ** 2.4)


def _shown(light):
    """Light as sRGB values."""
    import numpy
    light = numpy.clip(light, 0.0, 1.0)
    return numpy.where(light <= 0.0031308, light * 12.92, 1.055 * light ** (1.0 / 2.4) - 0.055)


def _tone(middle):
    """How a skin's middle color, as light, must change to be what skin has: no lighter and no darker than skin
    under a game's lights may be, and neither as pale nor as red as MakeHuman paints some of its skins. Returns the
    share of its color to keep and the scale of its lightness."""
    import numpy
    lightness = float((middle * numpy.array((0.2126, 0.7152, 0.0722))).sum())
    scale = min(max(lightness, SKIN_DARKEST), SKIN_LIGHTEST) / max(lightness, 1e-4)

    def saturation(share):
        """The middle color's saturation once its color is that share of what it was."""
        shown = _shown((lightness + (middle - lightness) * share) * scale)
        return float((shown.max() - shown.min()) / max(shown.max(), 1e-4))

    wanted = min(max(saturation(1.0), SKIN_PALEST), SKIN_DEEPEST)
    low, high = 0.3, 2.5
    for _ in range(24):
        share = (low + high) / 2.0
        if saturation(share) < wanted:
            low = share
        else:
            high = share
    return share, scale


def _tone_skin(image):
    """Bring a skin picture's middle color to what skin has, once. The picture keeps its own detail: every pixel
    is changed alike. A human seen up close is toned again by its face, in _finish_skin."""
    import numpy
    if image is None or image.get('wasd_toned'):
        return
    pixels = _pixels(image)
    light = _light(pixels[..., :3])
    share, scale = _tone(numpy.median(light[::8, ::8].reshape(-1, 3), axis=0))
    if abs(scale - 1.0) > 0.005 or abs(share - 1.0) > 0.01:
        gray = (light * numpy.array((0.2126, 0.7152, 0.0722), dtype=numpy.float32)).sum(-1, keepdims=True)
        pixels[..., :3] = _shown(numpy.maximum(gray + (light - gray) * share, 0.0) * scale)
        _keep(image, pixels)
    image['wasd_toned'] = True


def _brow_color(hair):
    """The color of brows under hair of a color, as the color of one brow hair: a little lighter than dark hair's
    own, since brow hairs lie thin over skin where a head's hair lies on hair and is dark for it, and never fair: the
    brows of a blond head are a shade darker than its hair, and those of a gray head a darker gray, or they are lost
    against the skin and leave the face a mask."""
    dark = [channel * 1.2 for channel in hair[:3]]
    vivid = (max(dark) - min(dark)) / max(max(dark), 1e-4)
    most = 0.44 - 0.1 * min(vivid / 0.4, 1.0)
    return tuple(channel * min(1.0, most / max(max(dark), 1e-4)) for channel in dark)


def _whiten(image):
    """Repaint a picture of teeth and gums, once: MakeHuman's is a photograph in a dim light, whose teeth are gray
    with black between them and whose gums are a dark red, and a game's lights make old teeth of it. The teeth turn
    ivory with a soft shade where the photograph is dark, and the gums a healthy pink."""
    import numpy
    if image is None or image.get('wasd_whitened'):
        return
    pixels = _pixels(image)
    color = pixels[..., :3]
    most, least = color.max(-1), color.min(-1)
    # Teeth are gray in the photograph and gums red.
    tooth = (1.0 - _smooth(0.12, 0.3, (most - least) / numpy.maximum(most, 1e-4)))[..., None]
    lit = _smooth(0.1, 0.75, most)[..., None]
    ivory = numpy.array((0.96, 0.94, 0.89), dtype=numpy.float32) * (0.58 + 0.42 * lit)
    pink = numpy.array((0.80, 0.45, 0.44), dtype=numpy.float32) * (0.62 + 0.38 * lit)
    pixels[..., :3] = ivory * tooth + pink * (1.0 - tooth)
    _keep(image, pixels)
    image['wasd_whitened'] = True


def _shade_mouth(parts):
    """Let the inside of a mouth fall into the dark toward its back and toward the gums: each vertex of the teeth
    and the tongue gets, as its color, how much light reaches it, all of it at the front teeth's edges, less under
    the lips, where teeth stand in the lips' shade, and a third of it at the last tooth. A game multiplies a mesh's
    picture by it, so that an open mouth shows its front teeth and not a lit row of molars, and a grin's teeth are
    no white bar."""
    reach = 0.014
    # The human faces -Y: the front of the mouth is its least Y.
    front = min((part.matrix_world @ vertex.co).y for part in parts for vertex in part.data.vertices)
    # The first part holds both rows of teeth, each tooth an island of its mesh: the rows meet between the tips
    # of the lower half of them and the edges of the upper half.
    spans = []
    for island in _islands(parts[0]):
        if len(island) < 0.2 * len(parts[0].data.vertices):
            heights = [(parts[0].matrix_world @ parts[0].data.vertices[index].co).z for index in island]
            spans.append((min(heights), max(heights)))
    spans.sort(key=lambda span: span[0] + span[1])
    half = len(spans) // 2
    bite = (sum(top for _, top in spans[:half]) / half + sum(low for low, _ in spans[half:]) / (len(spans) - half)) / 2.0 if half else 0.0
    # Each tooth is round: its two sides, toward its neighbors, turn from the light, and that is what parts one
    # tooth from the next where a picture's lines between teeth are finer than a pixel.
    sides = {}
    if half:
        places = [parts[0].matrix_world @ vertex.co for vertex in parts[0].data.vertices]
        middle = sum((place.y for place in places), 0.0) / len(places)
        for island in _islands(parts[0]):
            if len(island) < 0.2 * len(places):
                center = sum((places[index] for index in island), places[0] * 0.0) / len(island)
                out = (center.x, center.y - middle)
                length = math.hypot(*out) or 1.0
                along = (-out[1] / length, out[0] / length)
                offsets = [(places[index].x - center.x) * along[0] + (places[index].y - center.y) * along[1] for index in island]
                widest = max(abs(offset) for offset in offsets) or 1.0
                for index, offset in zip(island, offsets):
                    sides[index] = abs(offset) / widest
    for at, part in enumerate(parts):
        colors = part.data.color_attributes.get('Color') or part.data.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
        for vertex, entry in zip(part.data.vertices, colors.data):
            place = part.matrix_world @ vertex.co
            back = min(max((place.y - front - 0.004) / reach, 0.0), 1.0)
            lit = 1.0 - 0.74 * back * back * (3.0 - 2.0 * back)
            if at == 0 and half:
                under = min(max((abs(place.z - bite) - 0.002) / 0.008, 0.0), 1.0)
                lit *= 1.0 - 0.45 * under * under * (3.0 - 2.0 * under)
                side = min(max((sides.get(vertex.index, 0.0) - 0.55) / 0.45, 0.0), 1.0)
                lit *= 1.0 - 0.28 * side * side * (3.0 - 2.0 * side)
            elif at:
                # A tongue lies in the floor of the mouth, a little in the shade of the teeth, and is seen in a mouth
                # that opens: it falls dark toward the throat more slowly than the rows of teeth toward the cheeks.
                deep = min(max((place.y - front - 0.004) / 0.03, 0.0), 1.0)
                lit = (1.0 - 0.7 * deep * deep * (3.0 - 2.0 * deep)) * 0.9
            entry.color = (lit, lit, lit, 1.0)
        part.data.color_attributes.active_color = colors
        part.data.color_attributes.render_color_index = part.data.color_attributes.find('Color')


def _middle_color(image):
    """The middle color of what a picture shows of hair, as sRGB, or none for no picture."""
    import numpy
    if image is None:
        return None
    pixels = _pixels(image)
    solid = pixels[..., 3] > 0.5
    if not solid.any():
        return None
    return tuple(float(value) for value in numpy.median(pixels[..., :3][solid][::7], axis=0))


def _recolor(image, color):
    """Give a picture of hair, brows, or lashes a color, keeping its strands' light and dark, and fill what shows
    through with the hair's own color: MakeHuman leaves that black, which rims every strand's edge with a dark line
    where a game smooths the picture. No color keeps the picture's own."""
    import numpy
    if image is None or image.get('wasd_recolored'):
        return
    pixels = _pixels(image)
    solid = pixels[..., 3] > 0.5
    if not solid.any():
        return
    if color is not None:
        light = _light(pixels[..., :3])
        bright = (light * numpy.array((0.2126, 0.7152, 0.0722), dtype=numpy.float32)).sum(-1)
        middle = float(numpy.median(bright[solid])) or 1.0
        wanted = _light(numpy.array(color[:3], dtype=numpy.float32))
        # A strand's share of the middle brightness carries over, a little flattened, so light hair keeps its depth.
        pixels[..., :3] = _shown(wanted * ((bright / middle) ** 0.8)[..., None])
    pixels[~solid, :3] = pixels[..., :3][solid].mean(0)
    _keep(image, pixels)
    image['wasd_recolored'] = True


def _soften_edge(hair, skin):
    """Let hair fade out along its hairline: each vertex gets, as the alpha of its color, how solid the hair is
    there, none on an open edge that lies on the skin and whole a finger's width in. A game that reads it, as
    WasdSurface.human does, draws a hairline that thins out into the skin instead of a wig's cut edge. An open edge
    that stands free of the skin, as the end of a lock does, stays solid: behind it lies more hair, not skin. skin
    is a search tree of the head's skin. The red of the color says how straight the hair is, 1 unless it was set:
    light lies in a band across straight hair and in none across curls."""
    import bmesh
    data = bmesh.new()
    data.from_mesh(hair.data)
    data.verts.ensure_lookup_table()
    world = hair.matrix_world
    away = {}
    for vertex in data.verts:
        if any(edge.is_boundary for edge in vertex.link_edges):
            found = skin.find_nearest(world @ vertex.co, 0.008)
            if found[0] is not None:
                away[vertex.index] = 0.0
    front = list(away)
    reach = 0.022
    # The way from each vertex to the nearest open edge, along the hair's own edges.
    while front:
        nearer = []
        for index in front:
            vertex = data.verts[index]
            for edge in vertex.link_edges:
                other = edge.other_vert(vertex)
                length = away[index] + edge.calc_length()
                if length < reach and length < away.get(other.index, reach):
                    away[other.index] = length
                    nearer.append(other.index)
        front = nearer
    data.free()
    colors = hair.data.color_attributes.get('Color') or hair.data.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    straight = float(hair.get('wasd_straight', 1.0))
    for index, entry in enumerate(colors.data):
        # No hairline is ruled: the hair thins out over a finger's width here and half of one there, by a wave
        # that runs along the head.
        spot = world @ hair.data.vertices[index].co
        waver = 0.75 + 0.35 * math.sin(spot.x * 310.0 + 1.3 * math.sin(spot.z * 170.0)) * math.sin(spot.y * 140.0 + 0.7)
        solid = min(away.get(index, reach) / (reach * waver), 1.0)
        entry.color = (straight, 1.0, 1.0, solid * solid * (3.0 - 2.0 * solid))
    hair.data.color_attributes.active_color = colors
    hair.data.color_attributes.render_color_index = hair.data.color_attributes.find('Color')


def _taper_lashes(lashes, eyes, full=1.0):
    """Let eyelashes thin out toward their tips: each vertex gets, as the alpha of its color, how solid the lashes
    are there, whole along the lid and faint at the tips. From a step away single lashes are too fine to be seen,
    and a game then draws a lash card as a film over the lid, as dark as the lashes are dense: with tips that
    fade, that film is a dark line along the lid's edge, as lashes look from there, and no shadow on the lid. full
    is how solid the upper lid's lashes are at their roots."""
    from mathutils import Vector
    mesh = lashes.data
    spots = [lashes.matrix_world @ vertex.co for vertex in mesh.vertices]
    balls = [eyes.matrix_world @ vertex.co for vertex in eyes.data.vertices]
    colors = mesh.color_attributes.get('Color') or mesh.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for sign in (1.0, -1.0):
        ball = [spot for spot in balls if spot.x * sign > 0.0]
        mine = [index for index, spot in enumerate(spots) if spot.x * sign > 0.0]
        if not ball or not mine:
            continue
        center = sum(ball, Vector()) / len(ball)
        # A lash's root lies on the lid, a ball's radius from the eye's middle, and its tip the lash's length further.
        away = {index: (spots[index] - center).length for index in mine}
        root, tip = min(away.values()), max(away.values())
        for index in mine:
            along = min(max(((away[index] - root) / max(tip - root, 1e-6) - 0.05) / 0.65, 0.0), 1.0)
            # The lower lid's lashes are few and short beside the upper lid's.
            most = full if spots[index].z > center.z else 0.4 * full
            colors.data[index].color = (1.0, 1.0, 1.0, most * (1.0 - 0.9 * along * along * (3.0 - 2.0 * along)))
    mesh.color_attributes.active_color = colors
    mesh.color_attributes.render_color_index = mesh.color_attributes.find('Color')


def _hang_hair(hair):
    """Hang hair from the head, the neck, and the spine alone. MPFB gives hair the weights of the skin under it, so
    hair that lies on the shoulders follows the collarbones and the arms, and sticks out in spikes as soon as the
    arms come down from the pose the human was made in. Those weights go to the chest instead."""
    names = {group.index: group.name for group in hair.vertex_groups}
    keep = {index for index, name in names.items() if name in ('head', 'neck_01') or name.startswith('spine')}
    chest = next((hair.vertex_groups.get(name) for name in ('spine_03', 'spine_02', 'spine_01', 'neck_01') if hair.vertex_groups.get(name)), None)
    if chest is None or not keep:
        return
    for vertex in hair.data.vertices:
        loose = [(entry.group, entry.weight) for entry in vertex.groups if entry.group not in keep and entry.weight > 0.0]
        if not loose:
            continue
        for group, _ in loose:
            hair.vertex_groups[group].remove([vertex.index])
        chest.add([vertex.index], sum(weight for _, weight in loose), 'ADD')


def _lift_hair(hair, body, top, side):
    """Give hair the volume that hair has. MakeHuman's hair lies on the skull like a bathing cap: the head under it
    is as small as a bald one, and the face looks long and bare for it. Each vertex moves away from the skull's
    middle, by top mm at the crown and by side mm at the sides, on a face whose pupils are 62 mm apart, and by
    nothing where the hair meets the skin of the face or the neck, so that the hairline stays where it is; what
    hangs below the jaw keeps its place."""
    from mathutils import kdtree
    rest = np.array([(body.matrix_world @ vertex.co)[:] for vertex in body.data.vertices])
    skin, scalp = set(_in_group(body, 'body')), set(_in_group(body, 'scalp')) if 'scalp' in body.vertex_groups else set()
    bare = [index for name in ('head', 'neck_01') if name in body.vertex_groups for index in _in_group(body, name)
            if index in skin and index not in scalp]
    if not bare:
        return
    tree = kdtree.KDTree(len(bare))
    for at, index in enumerate(bare):
        tree.insert(rest[index], at)
    tree.balance()
    eyes = [rest[_in_group(body, f'helper-{side}-eye')].mean(axis=0) for side in 'lr']
    between, apart = (eyes[0] + eyes[1]) / 2.0, float(np.linalg.norm(eyes[0] - eyes[1]))
    mm = apart / 62.0
    # The skull's middle lies behind the eyes and a little above them. The human faces -Y.
    center = between + np.array([0.0, 1.25 * apart, 0.35 * apart])
    world = np.array(hair.matrix_world)
    spots = _coords(hair) @ world[:3, :3].T + world[:3, 3]
    away = spots - center
    out = away / np.maximum(np.linalg.norm(away, axis=1, keepdims=True), 1e-9)
    amount = (side + (top - side) * np.clip(out[:, 2], 0.0, 1.0) ** 1.5) * mm
    # All of it from the eyes' height up, and none a head's length below them.
    amount *= np.clip(((spots[:, 2] - between[2]) / (1.6 * apart) + 1.0) / 0.9, 0.0, 1.0)
    near = np.array([tree.find(spot)[2] for spot in spots])
    amount *= _ease(4.0 * mm, 39.0 * mm, near)
    moved = spots + out * amount[:, None]
    hair.data.vertices.foreach_set('co', ((moved - world[:3, 3]) @ np.linalg.inv(world[:3, :3]).T).ravel())
    hair.data.update()


def _raster(mesh, values, size, only=None):
    """Draw one number a vertex into a picture of a mesh's UV map: a size by size grid of the number at each point
    of the map, bottom row first, and which points the mesh covers. only names the faces to draw, by their index;
    none draws every face that has a number other than 0."""
    import numpy
    grid = numpy.zeros((size, size), dtype=numpy.float32)
    drawn = numpy.zeros((size, size), dtype=bool)
    layer = mesh.uv_layers.active.data
    for polygon in mesh.polygons:
        if only is not None and polygon.index not in only:
            continue
        mine = [values[index] for index in polygon.vertices]
        if only is None and not any(mine):
            continue
        corners = [(layer[loop].uv.x * size - 0.5, layer[loop].uv.y * size - 0.5) for loop in polygon.loop_indices]
        for third in range(1, len(corners) - 1):
            (ax, ay), (bx, by), (cx, cy) = corners[0], corners[third], corners[third + 1]
            area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
            if abs(area) < 1e-9:
                continue
            left, right = max(int(min(ax, bx, cx)) - 1, 0), min(int(max(ax, bx, cx)) + 2, size)
            low, high = max(int(min(ay, by, cy)) - 1, 0), min(int(max(ay, by, cy)) + 2, size)
            if left >= right or low >= high:
                continue
            ys, xs = numpy.mgrid[low:high, left:right]
            second = ((xs - ax) * (cy - ay) - (cx - ax) * (ys - ay)) / area
            last = ((bx - ax) * (ys - ay) - (xs - ax) * (by - ay)) / area
            first = 1.0 - second - last
            # A little past the triangle's edges, so that neighbors leave no gap between them.
            inside = (first >= -0.02) & (second >= -0.02) & (last >= -0.02)
            value = first * mine[0] + second * mine[third] + last * mine[third + 1]
            grid[low:high, left:right] = numpy.where(inside, value, grid[low:high, left:right])
            drawn[low:high, left:right] |= inside
    return grid, drawn


def _blur(grid, radius):
    """A picture of numbers, each the mean of those within a radius of it, twice over."""
    import numpy
    for _ in range(2):
        for axis in (0, 1):
            total = numpy.cumsum(numpy.pad(grid, [(radius + 1, radius) if at == axis else (0, 0) for at in (0, 1)], mode='edge'), axis=axis, dtype=numpy.float64)
            count = grid.shape[axis]
            ahead = numpy.take(total, range(2 * radius + 1, 2 * radius + 1 + count), axis=axis)
            behind = numpy.take(total, range(0, count), axis=axis)
            grid = ((ahead - behind) / (2 * radius + 1)).astype(numpy.float32)
    return grid


def _spread(grid, drawn, steps=3):
    """Carry a drawn picture's values a few pixels past what was drawn, so that a seam of the UV map shows no line."""
    import numpy
    for _ in range(steps):
        total = numpy.zeros_like(grid)
        count = numpy.zeros_like(grid)
        for shift, axis in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
            total += numpy.roll(grid * drawn, shift, axis)
            count += numpy.roll(drawn, shift, axis)
        fill = ~drawn & (count > 0)
        grid = numpy.where(fill, total / numpy.maximum(count, 1.0), grid)
        drawn = drawn | fill
    return grid, drawn


def _finish_skin(body, covers, roots=None, lids=None, groom=0.0, tone=(1.0, 0.0), fold=1.0):
    """Give the skin of the head what a painted skin lacks under a game's lights, which bounce no light into
    hollows and pass none through flesh, and groom it as a face that is looked at is groomed.

    A second picture, as a glTF material holds it, tells in its red how open each point of the head lies to the
    sky, so that a game dims the sky's light in the hollows of the face and under the hair without darkening the
    skin's own color, and in its green where skin is glossy, on the brow, the nose, and the lips, and where it is
    matte. The skin's picture loses the orange and the shadows that MakeHuman paints round the eyes and the patches
    of its tone, and gets the blood of a healthy face in its cheeks and ears, lips of their own color, the dark line
    of the lashes' roots along the lids, and under the hair the color of the hair's roots, so that a hairline ends
    on skin of its own color. covers are the meshes that shade the head besides itself, such as its hair, roots is
    the hair's sRGB color, or none, lids are the vertices of each eye's lid edges and lid crease, by side, of the
    line where the lips meet, and of the groove under the lower lip, groom, from 0 to 1, is how much color the lips and the cheeks get and how dark
    the lids' lines are, tone is how much lighter than its kind's this skin is, as a factor, and how much warmer,
    from -1 to 1, and fold is how deep the upper lids' creases are."""
    import numpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    material = body.material_slots[0].material if body.material_slots else None
    image = _picture_of(material)
    if image is None or image.get('wasd_finished'):
        return
    mesh = body.data
    rig = body.parent if body.parent is not None and body.parent.type == 'ARMATURE' else None
    groups = {group.name: group.index for group in body.vertex_groups}
    on_head = {groups[name] for name in ('head', 'neck_01') if name in groups}
    if not on_head:
        return
    # The body as it stands now, with its shape so far, and without the masks that hide its helper geometry and
    # change its count of vertices.
    masks = [modifier for modifier in body.modifiers if modifier.type == 'MASK' and modifier.show_viewport]
    for mask in masks:
        mask.show_viewport = False
    graph = bpy.context.evaluated_depsgraph_get()
    graph.update()
    shown = body.evaluated_get(graph)
    seen = shown.to_mesh()
    points = [body.matrix_world @ vertex.co for vertex in seen.vertices]
    normals = [vertex.normal.copy() for vertex in seen.vertices]
    shown.to_mesh_clear()
    for mask in masks:
        mask.show_viewport = True
    if len(points) != len(mesh.vertices):
        return
    # Helper geometry, which MPFB keeps inside and round the body, is no skin: the group "body" holds the skin.
    skin = groups.get('body')
    head = {vertex.index for vertex in mesh.vertices
            if (skin is None or any(entry.group == skin and entry.weight > 0.5 for entry in vertex.groups))
            and sum(entry.weight for entry in vertex.groups if entry.group in on_head) > 0.5}
    faces = {polygon.index for polygon in mesh.polygons if all(index in head for index in polygon.vertices)}
    if not faces:
        return

    def tree_of(part):
        world = part.matrix_world
        return BVHTree.FromPolygons([world @ vertex.co for vertex in part.data.vertices],
                                    [list(polygon.vertices) for polygon in part.data.polygons], all_triangles=False)

    # What stands in the light's way: the head's own skin, and what covers it.
    own = BVHTree.FromPolygons(points, [list(mesh.polygons[index].vertices) for index in faces], all_triangles=False)
    balls = [child for child in (rig.children if rig is not None else []) if child.type == 'MESH' and 'poly' in child.name]
    for cover in covers:
        _soften_edge(cover, own)
    over = [tree_of(cover) for cover in covers]
    # Rays over the half ball above a point, each counted by how straight it leaves the skin.
    rays = []
    for index in range(20):
        height = 1.0 - (index + 0.5) / 20.0 * 0.92
        turn = index * 2.399963
        ring = math.sqrt(max(1.0 - height * height, 0.0))
        rays.append(Vector((ring * math.cos(turn), ring * math.sin(turn), height)))
    whole = sum(ray.z for ray in rays)
    # The head's own skin shades a hollow from a hand's width off; the hair only what it lies on, or a lock that
    # hangs beside a cheek would draw its shadow on it for good.
    reach, close = 0.09, 0.03
    hollow = [0.0] * len(mesh.vertices)
    under = [0.0] * len(mesh.vertices)
    for index in head:
        normal = normals[index]
        aside = normal.orthogonal().normalized()
        other = normal.cross(aside)
        start = points[index] + normal * 0.0015
        hidden = covered = 0.0
        for ray in rays:
            toward = aside * ray.x + other * ray.y + normal * ray.z
            hit = own.ray_cast(start, toward, reach)
            hidden += 0.0 if hit[0] is None else (1.0 - hit[3] / reach) ** 2 * ray.z
            dim = 0.0
            for tree in over:
                hit = tree.ray_cast(start, toward, close)
                if hit[0] is not None:
                    dim = max(dim, 1.0 - hit[3] / close)
            covered += dim * ray.z
        hollow[index] = hidden / whole
        under[index] = covered / whole
    # Smoothed over the skin, so that no single vertex stands out.
    near = {index: [] for index in head}
    for edge in mesh.edges:
        first, second = edge.vertices
        if first in near and second in near:
            near[first].append(second)
            near[second].append(first)
    for _ in range(2):
        hollow, under = ([(values[index] + sum(values[other] for other in near[index])) / (1 + len(near[index])) if index in near else 0.0
                          for index in range(len(mesh.vertices))] for values in (hollow, under))

    # Where the face's parts lie, told from the eyes, the lips, and the head's own width.
    eyes = []
    for ball in balls[:1]:
        spots = [ball.matrix_world @ vertex.co for vertex in ball.data.vertices]
        for sign in (1.0, -1.0):
            side = [spot for spot in spots if spot.x * sign > 0.0]
            if side:
                eyes.append(sum(side, Vector()) / len(side))
    lips = set(_in_group(body, 'lips')) & head if 'lips' in groups else set()
    # The lower lip's red ends at its edge: red that runs on into the groove under it gives the lip a second edge,
    # with the groove's shade as a dark line through the red.
    lips -= {int(index) for index in (lids or {}).get('under_lip', ())}
    blood = [0.0] * len(mesh.vertices)
    liner = [0.0] * len(mesh.vertices)
    crease = [0.0] * len(mesh.vertices)
    parting = [0.0] * len(mesh.vertices)
    for side in 'lr':
        lid = (lids or {}).get(side)
        if lid is None:
            continue
        # The lashes' line is thin at the eye's inner corner and full at its outer one, as lashes are, and the
        # lower lid's is a third of it, toward the outer corner alone.
        out = [abs(points[int(index)].x) for index in lid['edge']]
        nearest, farthest = min(out), max(out)
        along = lambda index: (abs(points[int(index)].x) - nearest) / max(farthest - nearest, 1e-6)
        for index in lid['edge']:
            liner[int(index)] = 0.4 + 0.6 * along(index)
        for index in lid['next']:
            liner[int(index)] = 0.5 * (0.4 + 0.6 * along(index))
        for index in lid['lower']:
            liner[int(index)] = 0.3 * min(max(along(index) * 2.0 - 0.6, 0.0), 1.0)
        for index in lid['crease']:
            crease[int(index)] = 1.0
        for index in lid['beside']:
            crease[int(index)] = 0.35
    for index in (lids or {}).get('mouth', ()):
        parting[int(index)] = 1.0
    groove = [0.0] * len(mesh.vertices)
    for index in (lids or {}).get('under_lip', ()):
        groove[int(index)] = 1.0
    gloss = [0.0] * len(mesh.vertices)
    rims = [0.0] * len(mesh.vertices)
    front = [0.0] * len(mesh.vertices)
    crown = [0.0] * len(mesh.vertices)
    bags = [0.0] * len(mesh.vertices)
    if len(eyes) == 2:
        # The lids' rims, which MakeHuman paints an orange that a sun sets alight.
        wide = abs(eyes[0].x - eyes[1].x) * 0.42
        for index in head:
            nearest = min((points[index] - eye).length for eye in eyes) / wide
            rims[index] = max(1.0 - nearest * nearest, 0.0)
    if len(eyes) == 2 and lips:
        between = (eyes[0] + eyes[1]) / 2.0
        mouth = sum((points[index] for index in lips), Vector()) / len(lips)
        apart = abs(eyes[0].x - eyes[1].x)
        down = between.z - mouth.z
        sides = (min(points[index].x for index in head), max(points[index].x for index in head))

        def on_front(across, height, radius, index):
            """How near a point of the face's front lies to a spot, seen from the front: 1 on it, 0 a radius off."""
            point = points[index]
            away = math.hypot(point.x - across, point.z - height) / radius
            # The human faces -Y: skin that faces away from the front is no part of the face.
            return max(1.0 - away * away, 0.0) * min(max(-normals[index].y * 1.6, 0.0), 1.0)

        for index in head:
            point = points[index]
            cheek = max(on_front(sign * apart * 0.68, between.z - down * 0.52, apart * 0.5, index) for sign in (1.0, -1.0))
            nose = on_front(0.0, between.z - down * 0.56, apart * 0.26, index)
            ridge = on_front(0.0, between.z - down * 0.25, apart * 0.22, index)
            chin = on_front(0.0, mouth.z - down * 0.62, apart * 0.34, index)
            brow = on_front(0.0, between.z + down * 0.62, apart * 0.75, index)
            ear = 0.0
            for side in sides:
                if abs(point.x - side) < apart * 0.35:
                    away = math.hypot(point.x - side, point.z - (between.z - down * 0.2)) / (apart * 0.5)
                    ear = max(ear, 1.0 - away * away)
            # A healthy face has color in its cheeks and its ears, and a little on its nose and its chin.
            blood[index] = min(cheek * (0.36 + 0.4 * groom) + nose * 0.2 + ear * 0.45 + chin * 0.1, 1.0)
            front[index] = on_front(0.0, between.z - down * 0.3, apart * 1.25, index)
            # Under each eye, where skin is thin and a little darker.
            bags[index] = max(max(1.0 - ((point.x - eye.x) / (apart * 0.3)) ** 2 - ((point.z - eye.z + apart * 0.3) / (apart * 0.17)) ** 2, 0.0)
                              for eye in eyes) * min(max(-normals[index].y * 1.6, 0.0), 1.0)
            # Where hair grows: above a line that runs from the top of the forehead past the temple and round the
            # ear to the nape, by how far behind the eyes a point lies. The ears themselves are skin.
            line = float(numpy.interp((point.y - between.y) / apart, (0.2, 0.9, 1.25, 1.9, 2.4), (0.6, 0.2, -0.35, -0.9, -1.6)))
            crown[index] = min(max(((point.z - between.z) / down - line) / 0.2 + 0.5, 0.0), 1.0) * (1.0 - min(max(ear, 0.0) * 2.0, 1.0))
            # Skin shines where it lies tight over bone, on the nose's tip and ridge, the brow, and the cheekbones,
            # and on the lips, the lower one most.
            # A man's lips are not made up, and shine less than half as much.
            gloss[index] = min(nose * 0.6 + ridge * 0.5 + brow * 0.35 + chin * 0.3 + cheek * 0.5
                               + (1.0 if index in lips and point.z < mouth.z else 0.6 if index in lips else 0.0) * min(0.4 + 1.2 * groom, 1.0), 1.0)
    size = image.size[0]
    pixels = _pixels(image)
    light = _light(pixels[..., :3])
    creases, drawn = _spread(*_raster(mesh, hollow, size, faces))
    thatch, _ = _spread(*_raster(mesh, under, size, faces))
    flush, _ = _spread(*_raster(mesh, blood, size, faces))
    face, _ = _spread(*_raster(mesh, front, size, faces))
    scalp, _ = _spread(*_raster(mesh, crown, size, faces))
    thin, _ = _spread(*_raster(mesh, bags, size, faces))
    round_eyes, _ = _spread(*_raster(mesh, rims, size, faces))
    lined, _ = _spread(*_raster(mesh, liner, size, faces))
    creased, _ = _spread(*_raster(mesh, crease, size, faces))
    parted, _ = _spread(*_raster(mesh, parting, size, faces))
    sunk, _ = _spread(*_raster(mesh, groove, size, faces))
    upper_lip = [1.0 if index in lips and points[index].z > points[MARKS['sto']].z else 0.0 for index in range(len(mesh.vertices))]
    over_mouth, _ = _spread(*_raster(mesh, upper_lip, size, faces))
    mouth_mask, _ = _spread(*_raster(mesh, [1.0 if index in lips else 0.0 for index in range(len(mesh.vertices))], size, faces))
    no_lips = 1.0 - numpy.clip(mouth_mask * 1.5, 0.0, 1.0)
    weights = numpy.array((0.2126, 0.7152, 0.0722), dtype=numpy.float32)
    bright = (light * weights).sum(-1, keepdims=True)
    # The face's own middle color, from its front: the scalp, which MakeHuman paints with stubble, is no measure,
    # nor is the body, which may be of another tone than the face. The whole picture is toned by the face.
    plain = drawn & (face > 0.5) if (drawn & (face > 0.5)).sum() > 500 else drawn
    share, scale = _tone(numpy.median(light[plain][::16], axis=0).astype(numpy.float64))
    # This skin's own tone, a little off its kind's: lighter or darker, and with more red and less blue or less red
    # and more blue.
    own = numpy.array((1.0 + 0.03 * tone[1], 1.0, 1.0 - 0.05 * tone[1]), dtype=numpy.float32) * scale * tone[0]
    light = (numpy.maximum(bright + (light - bright) * share, 0.0) * own).astype(numpy.float32)
    bright = (light * weights).sum(-1, keepdims=True)
    toned = light
    hue = light / numpy.maximum(bright, 1e-4)
    usual = numpy.median(hue[plain][::16], axis=0)
    middle = float(numpy.median(bright[plain][::16]))
    # Where MakeHuman painted stubble: on the scalp, where the picture is darker than the face, taken wide and soft
    # so that single hairs of it leave no specks.
    stubble = _blur(1.0 - _smooth(0.76, 0.93, bright[..., 0] / max(middle, 1e-4)), max(size // 340, 1)) * scalp
    # MakeHuman's skins have patches of orange and red round the eyes and on the nose, which a game's light turns
    # into a rash, and lids painted as dark as a photograph's shade made them, which a game shades a second time:
    # the skin there is drawn toward the face's middle color, and what is darker than it is lifted. The lips are
    # left as they are, and the rest keeps most of its color: skin of one even color is a doll's.
    even = (numpy.clip(0.3 + 0.25 * face + 0.55 * round_eyes, 0.0, 0.9) * no_lips)[..., None]
    lift = (numpy.clip(round_eyes * 1.3, 0.0, 1.0) * no_lips * 0.8)[..., None]
    bright = bright + (numpy.maximum(bright, middle * 0.9) - bright) * lift
    # A face is nearly of one tone from brow to chin where MakeHuman's is lighter here and darker there by a hand's
    # width: a third of that goes. All of it gone is a mask's one flat value.
    wide = _blur(bright[..., 0], max(size // 48, 1))[..., None]
    bright = bright * (1.0 + (face * no_lips)[..., None] * 0.3 * (middle / numpy.maximum(wide, 1e-4) - 1.0))
    light = (hue * (1.0 - even) + usual * even) * bright
    # A crease of skin is a little warmer and deeper than the skin round it: the light in it has passed through
    # flesh. Only a little, for the game shades the hollows itself, by the second picture.
    deep = numpy.clip(creases * 0.8, 0.0, 0.2)[..., None]
    light = light * (1.0 - deep * numpy.array((0.30, 0.45, 0.50), dtype=numpy.float32))
    # Skin is never of one tone: it is mottled, redder here and paler there, in patches a finger wide.
    cells = size // 36 + 1
    mottle = _blur(numpy.kron(numpy.random.default_rng(7).random((36, 36)).astype(numpy.float32),
                              numpy.ones((cells, cells), dtype=numpy.float32))[:size, :size], max(cells // 2, 1))
    mottle = ((mottle - mottle.mean()) / max(float(mottle.std()), 1e-4))[..., None]
    # Blood shows through fair skin more than through dark, and in patches: a blush of one even tone is painted on.
    fair = float(numpy.clip(middle / 0.3, 0.35, 1.0))
    red = (flush * 0.36 * fair)[..., None] * numpy.clip(1.0 + 0.3 * mottle, 0.4, 1.6)
    light = light * (1.0 - red * numpy.array((0.0, 0.75, 0.85), dtype=numpy.float32))
    light = light * (1.0 + mottle * numpy.array((0.02, -0.012, -0.017), dtype=numpy.float32) * fair)
    # Under the eyes a rested face is as light as the cheeks, and a touch lighter: what is dark there is tiredness.
    below = (thin * 0.05)[..., None]
    light = light * (1.0 + below)
    # The lips: their own color, deeper than the skin round them, with an edge to it. The upper lip faces down and
    # is the darker of the two, and where the lips meet lies a dark line: without the two a mouth is a smudge.
    lip = _smooth(0.3, 0.7, mouth_mask)[..., None]
    light = light * (1.0 - lip * numpy.array((0.02, 0.14, 0.07), dtype=numpy.float32) * (0.5 + 2.6 * groom))
    light = light * (1.0 - 0.12 * lip * numpy.clip(over_mouth, 0.0, 1.0)[..., None])
    # MakeHuman paints the rim of a lip cooler than its middle, which a game's light turns violet: the lips' red is
    # drawn halfway to its own middle color.
    red_of = (lip[..., 0] > 0.8) & drawn
    if int(red_of.sum()) > 50:
        lit = (light * weights).sum(-1, keepdims=True)
        tint = numpy.median((light / numpy.maximum(lit, 1e-4))[red_of][::4], axis=0)
        light = light * (1.0 - 0.5 * lip) + tint * lit * 0.5 * lip
    # Under the lower lip lies a soft shade, which sets the lip off from the chin: without it a mouth is flat.
    light = light * (1.0 - 0.14 * numpy.clip(sunk, 0.0, 1.0) ** 1.5)[..., None]
    meet = (numpy.clip(parted * 1.3, 0.0, 1.0) ** 2 * 0.5)[..., None]
    light = light * (1.0 - meet) + light * numpy.array((0.45, 0.3, 0.3), dtype=numpy.float32) * meet
    # The upper lid's crease, where the lid folds under the skin of the brow: a soft warm shade, which gives the
    # lid its depth. A lid without it is a flat band over the eye.
    folded = (numpy.clip(creased, 0.0, 1.0) * 0.2 * fold)[..., None]
    light = light * (1.0 - folded * numpy.array((0.8, 1.0, 1.0), dtype=numpy.float32))
    # The lashes' roots draw a dark line along the upper lid's edge, which is what sets an eye off from the face.
    line = (numpy.clip(lined * 1.25, 0.0, 1.0) ** 1.5 * (0.36 + 0.5 * groom))[..., None]
    light = light * (1.0 - line) + numpy.array((0.012, 0.008, 0.007), dtype=numpy.float32) * line
    if roots is not None:
        # Where hair grows, skin takes the color of this hair's roots in place of the stubble's, and under the hair
        # itself a little more of it: a hairline then ends on skin of its own color, whatever color the hair is.
        rooted = numpy.clip(stubble * 0.9 + numpy.clip(thatch * 2.0 - 0.1, 0.0, 1.0) * scalp * 0.5, 0.0, 0.92)[..., None]
        root = usual * middle * 0.25 + _light(numpy.array(roots[:3], dtype=numpy.float32)) * 0.75
        light = light * (1.0 - rooted) + root * 0.9 * rooted
    # Hair shades the skin at its edge: a soft band under a hairline, which sets the hair on the head instead of on
    # top of it.
    light = light * (1.0 - 0.22 * _blur(numpy.clip(thatch, 0.0, 1.0), max(size // 90, 1)))[..., None]
    # What follows the toning is the head's alone.
    pixels[..., :3] = _shown(numpy.where(drawn[..., None], light, toned))
    _keep(image, pixels)
    image['wasd_finished'] = True
    # The second picture, laid out as a glTF material's: red is how open a point lies, green its roughness.
    small = 1024
    # Hair shades the skin it lies on: a forehead under a hairline is a little darker for it. The eyes' sockets
    # are no hollows for it: a brow's shade on the eyes is what makes a face scowl.
    shut, covered = _spread(*_raster(mesh, [min(first * 0.5 * (1.0 - 0.7 * rim) + second * 0.65, 0.85)
                                            for first, second, rim in zip(hollow, under, rims)], small, faces))
    shine, _ = _spread(*_raster(mesh, gloss, small, faces))
    openness = numpy.where(covered, 1.0 - shut, 1.0).astype(numpy.float32)
    rough = numpy.where(covered, 0.68 - 0.22 * shine, 0.68).astype(numpy.float32)
    picture = bpy.data.images.new(f'{body.name}.skin_shade', small, small, alpha=False)
    picture.colorspace_settings.name = 'Non-Color'
    _keep(picture, numpy.stack([openness, rough, numpy.zeros_like(rough), numpy.ones_like(rough)], axis=-1))
    shader = next((node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
    if shader is not None:
        tree = material.node_tree
        texture = tree.nodes.new('ShaderNodeTexImage')
        texture.image = picture
        split = tree.nodes.new('ShaderNodeSeparateColor')
        tree.links.new(texture.outputs['Color'], split.inputs['Color'])
        tree.links.new(split.outputs['Green'], shader.inputs['Roughness'])
        # Blender's own shader has no input for occlusion: the glTF exporter reads it from a node of this name.
        output = bpy.data.node_groups.get('glTF Material Output')
        if output is None:
            output = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
            output.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        group = tree.nodes.new('ShaderNodeGroup')
        group.node_tree = output
        tree.links.new(split.outputs['Red'], group.inputs['Occlusion'])


def _smooth(low, high, value):
    import numpy
    share = numpy.clip((value - low) / (high - low), 0.0, 1.0)
    return share * share * (3.0 - 2.0 * share)


def _ring_noise(angle, counts, seed):
    """Noise round a circle: a sum of random steps of several sizes, read at an angle and smooth between them."""
    import numpy
    draw = numpy.random.default_rng(seed)
    turn = (angle / (2.0 * math.pi)) % 1.0
    total = numpy.zeros_like(angle)
    weight = 0.0
    for index, count in enumerate(counts):
        steps = draw.random(count)
        at = turn * count
        low = numpy.floor(at).astype(int) % count
        part = at - numpy.floor(at)
        part = part * part * (3.0 - 2.0 * part)
        share = 1.0 / (index + 1.0)
        total += (steps[low] * (1.0 - part) + steps[(low + 1) % count] * part) * share
        weight += share
    return total / weight


def _eye_layout(eyes):
    """Where each eyeball lies in an eye model's UV map: for the human's left (+X) and right eye, the ball's vertices
    and center, its radius, the UV of its pupil, and UV units per meter there. The pupil is where the eye model's own
    picture has it, and the ball is turned so that it looks straight ahead from there: MakeHuman's eyeballs are set
    a few degrees outward, and an eye that is turned by its bone from such a rest looks past what it looks at.
    MakeHuman's high-poly eyes also have an outer shell, mapped to a small disc in a corner of the picture: its
    vertices are returned apart."""
    import numpy
    from mathutils import Vector
    mesh = eyes.data
    layer = mesh.uv_layers.active.data
    first = {}
    for loop in mesh.loops:
        first.setdefault(loop.vertex_index, layer[loop.index].uv.copy())
    near = {index: set() for index in range(len(mesh.vertices))}
    for edge in mesh.edges:
        near[edge.vertices[0]].add(edge.vertices[1])
        near[edge.vertices[1]].add(edge.vertices[0])
    seen, groups = set(), []
    for start in near:
        if start in seen:
            continue
        stack, group = [start], []
        seen.add(start)
        while stack:
            index = stack.pop()
            group.append(index)
            for other in near[index]:
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        groups.append(group)

    def span(group):
        across = [first[index].x for index in group]
        up = [first[index].y for index in group]
        return (max(across) - min(across)) * (max(up) - min(up))

    image = _picture_of(eyes.material_slots[0].material) if eyes.material_slots else None
    shown = _pixels(image) if image is not None else None
    balls, shell = {}, set()
    for side, sign in (('l', 1.0), ('r', -1.0)):
        mine = sorted((group for group in groups if sum(mesh.vertices[index].co.x for index in group) * sign > 0.0), key=span, reverse=True)
        if not mine:
            continue
        # A ball's map is far larger than a shell's.
        ball = mine[0]
        for group in mine[1:]:
            shell.update(group)
        points = numpy.array([mesh.vertices[index].co[:] for index in ball])
        maps = numpy.array([first[index][:] for index in ball])
        center, radius = _fit_ball(points)
        # The human faces -Y: the front half is what the picture's eye is drawn on.
        front = points[:, 1] < center[1]
        pupil = None
        if shown is not None:
            low, high = maps[front].min(0), maps[front].max(0)
            height, width = shown.shape[:2]
            left, right = int(low[0] * width), int(math.ceil(high[0] * width))
            bottom, top = int(low[1] * height), int(math.ceil(high[1] * height))
            part = shown[bottom:top, left:right, :3]
            dark = part.sum(-1) < 0.2
            if dark.sum() > 20:
                rows, columns = numpy.nonzero(dark)
                pupil = ((left + columns.mean() + 0.5) / width, (bottom + rows.mean() + 0.5) / height)
        if pupil is not None:
            # The point of the ball that the pupil is drawn on, from the vertices next to it in the map.
            away = numpy.linalg.norm(maps - numpy.array(pupil), axis=1)
            nearest = numpy.argsort(away)[:6]
            weights = 1.0 / numpy.maximum(away[nearest], 1e-5)
            spot = (points[nearest] * weights[:, None]).sum(0) / weights.sum()
            axis = Vector(spot - center)
            if axis.length > 1e-6 and axis.normalized().y < -0.7:
                turn = axis.normalized().rotation_difference(Vector((0.0, -1.0, 0.0))).to_matrix()
                middle = Vector(center)
                for index in ball:
                    vertex = mesh.vertices[index]
                    vertex.co = middle + turn @ (vertex.co - middle)
                for group in mine[1:]:
                    for index in group:
                        vertex = mesh.vertices[index]
                        vertex.co = middle + turn @ (vertex.co - middle)
                points = numpy.array([mesh.vertices[index].co[:] for index in ball])
                front = points[:, 1] < center[1]
        design = numpy.c_[points[front][:, 0] - center[0], points[front][:, 2] - center[2], numpy.ones(int(front.sum()))]
        across = numpy.linalg.lstsq(design, maps[front][:, 0], rcond=None)[0]
        up = numpy.linalg.lstsq(design, maps[front][:, 1], rcond=None)[0]
        balls[side] = {
            'vertices': ball,
            'center': center,
            'radius': radius,
            'pole': pupil if pupil is not None else (float(across[2]), float(up[2])),
            'per_meter': float(math.hypot(across[0], up[0])),
            # Which way the map's +U runs on the ball: +1 toward the human's left (+X).
            'across': 1.0 if across[0] > 0.0 else -1.0,
            'side': sign,
        }
    mesh.update()
    return balls, shell


def _fit_ball(points):
    """The middle and the radius of the ball that an eyeball's points lie on. Its iris is a dish set into it, whose
    points lie off the ball, and its back is cut off, so the middle of what it spans is not the ball's."""
    points = np.asarray(points, dtype=float)
    keep = np.ones(len(points), dtype=bool)
    for _ in range(3):
        fit = np.linalg.lstsq(np.c_[2.0 * points[keep], np.ones(int(keep.sum()))], (points[keep] ** 2).sum(1), rcond=None)[0]
        center = fit[:3]
        radius = float(math.sqrt(max(fit[3] + (center ** 2).sum(), 1e-12)))
        keep = np.linalg.norm(points - center, axis=1) > radius - 0.0006
    return center, radius


def _paint_eyes(balls, color, size):
    """An eye picture for a UV layout: for each ball a white that is a little warm, never pure, with a few faint
    veins toward its corners, an iris of the color with fibers, a dark rim, and a lighter ring round the pupil.
    Returns rows of RGBA floats, bottom row first."""
    import numpy
    inner, rim, ring = (numpy.array(value) for value in EYE_COLORS[color])
    rows, columns = numpy.mgrid[0:size, 0:size]
    across = (columns + 0.5) / size
    up = (rows + 0.5) / size
    white = numpy.array((0.82, 0.8, 0.78))
    picture = numpy.empty((size, size, 3))
    picture[:] = white
    nearest = numpy.full((size, size), 1e9)
    middles = [numpy.array(ball['center']) for ball in balls.values()]
    # A mm of this face, by its eyes, as the head that sets its lids counts it.
    mm = float(numpy.linalg.norm(middles[0] - middles[1])) / 62.0 if len(middles) == 2 else 1e9
    for number, ball in enumerate(balls.values()):
        aside = (across - ball['pole'][0]) / ball['per_meter']
        above = (up - ball['pole'][1]) / ball['per_meter']
        meters = numpy.hypot(aside, above)
        # In shares of the iris's radius. The map is a little wider at the iris's rim than at the pupil: an iris
        # drawn 1.035 times as wide ends where it should.
        iris = min(ball['radius'] * IRIS, IRIS_MOST * mm) * 1.035
        out = meters / iris
        angle = numpy.arctan2(above, aside)
        mine = meters < nearest
        nearest = numpy.where(mine, meters, nearest)
        # The white is white as far round the ball as an eye that turns can show: what is painted darker or pink
        # toward a corner turns with the eye, into its middle. The corners' shade and warmth are the lids', which a
        # game's eye shader, such as WasdSurface's, lays on the eye where the lids are.
        far = _smooth(2.4, 3.0, out)
        shade = white * (1.0 - far[..., None]) + numpy.array((0.78, 0.64, 0.60)) * far[..., None]
        veins = _ring_noise(angle + 0.06 * numpy.sin(out * 3.1 + number), (61, 131, 277), 18 + 11 * number)
        vein = _smooth(0.80, 0.90, veins) * _smooth(1.7, 2.6, out) * 0.09
        shade = shade * (1.0 - vein[..., None]) + numpy.array((0.66, 0.36, 0.33)) * vein[..., None]
        # A soft shade where the white meets the iris.
        shade = shade * (1.0 - 0.14 * (1.0 - _smooth(1.0, 1.22, out)))[..., None]
        fibers = _ring_noise(angle, (37, 89, 211, 467), 7 + 3 * number)
        coarse = _ring_noise(angle + 0.2 * out, (9, 17), 12 + 5 * number)
        outward = _smooth(0.28, 1.0, out)
        tone = (inner * (1.0 - outward[..., None]) + rim * outward[..., None]) * (0.55 + 0.85 * fibers * (0.55 + 0.45 * coarse))[..., None]
        edge = 0.46 + 0.07 * (coarse - 0.5)
        collar = (1.0 - _smooth(edge - 0.05, edge + 0.07, out)) * _smooth(0.26, 0.34, out)
        tone = tone * (1.0 - 0.55 * collar[..., None]) + ring * (0.8 + 0.4 * fibers)[..., None] * 0.55 * collar[..., None]
        tone = tone * (1.0 - 0.72 * _smooth(0.80, 0.99, out))[..., None]
        pupil = 1.0 - _smooth(0.25, 0.34, out)
        tone = tone * (1.0 - pupil[..., None]) + numpy.array((0.015, 0.012, 0.012)) * pupil[..., None]
        meet = _smooth(0.93, 1.06, out)
        picture = numpy.where(mine[..., None], tone * (1.0 - meet[..., None]) + shade * meet[..., None], picture)
    return numpy.concatenate([numpy.clip(picture, 0.0, 1.0), numpy.ones((size, size, 1))], axis=2).astype(numpy.float32)


def _natural_eyes(eyes, color, size=1024):
    """Give an MPFB human's eyes a natural look. MakeHuman's eye pictures have irises of a red that no eye has, and
    its high-poly eyes an outer shell that a game engine draws over the eye. The eyes get an iris picture painted for
    the eye model's own UV layout, lose the shell, and get a ball's normals, so that they take light as smooth wet
    balls whatever the iris's own dish does."""
    import bmesh
    from mathutils import Vector
    balls, shell = _eye_layout(eyes)
    if len(balls) < 2:
        return
    # A name with "eyes" in it, by which a game's material fix-up, such as WasdSurface.human, knows what it holds.
    name = f'{eyes.name.split(".")[0]}.eyes_{color}'
    image = bpy.data.images.new(name, size, size, alpha=False)
    _keep(image, _paint_eyes(balls, color, size))
    centers = {index: Vector(ball['center']) for ball in balls.values() for index in ball['vertices']}
    if shell:
        data = bmesh.new()
        data.from_mesh(eyes.data)
        data.verts.ensure_lookup_table()
        kept = [vertex.index for vertex in data.verts if vertex.index not in shell]
        bmesh.ops.delete(data, geom=[data.verts[index] for index in shell], context='VERTS')
        data.to_mesh(eyes.data)
        data.free()
        centers = {new: centers[old] for new, old in enumerate(kept)}
    eyes.data.normals_split_custom_set_from_vertices(
        [tuple((vertex.co - centers[vertex.index]).normalized()) for vertex in eyes.data.vertices])
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    shader = nodes.get('Principled BSDF')
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    material.node_tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
    shader.inputs['Roughness'].default_value = 0.1
    eyes.data.materials.clear()
    eyes.data.materials.append(material)


def _fitted(services, body, kinds):
    """The meshes of a human that MPFB fitted to its body, of some object types."""
    rig = body.parent if body.parent is not None and body.parent.type == 'ARMATURE' else None
    family = rig.children if rig is not None else body.children
    return [child for child in family
            if child is not body and child.type == 'MESH' and str(services.ObjectService.get_object_type(child) or '') in kinds]


def add_face(module, body, shapes=None, eye_bones=True):
    """Give a dressed human a face that a game can move, as the last step before the export.

    The body, its proxy, and the eyelashes, eyebrows, teeth, and tongue get one shape key for each name of shapes
    (default: all of FACE_SHAPES), and the eyes get the bones eye_l and eye_r under the head. The shapes are made on
    this human's own face: the jaw opens about its hinge and takes the lower teeth and the tongue with it, the lips
    move by rule, and the skin round them follows as skin does. The lips are closed, and the teeth are seated behind
    them where a mouth that opens shows the upper teeth's edge. The mesh that shows the head, the proxy or else the
    body, gets the inside of a mouth, teeth and darkness behind them, where it has none: a proxy's head is a shell
    through whose open mouth the scene would show. The body's shape so far becomes its rest shape, and its masks are
    applied, so that the export keeps the shape keys. Returns what it added.
    """
    services = importlib.import_module(module + '.services')
    clothes = importlib.import_module(module + '.services.clothesservice').ClothesService
    targets = services.TargetService
    if body is None or not services.ObjectService.object_is_basemesh(body):
        raise ValueError('add_face takes the base mesh that wasd_mpfb.human or HumanService.create_human returned.')
    names = list(FACE_SHAPES) if shapes is None else list(shapes)
    unknown = [name for name in names if name not in FACE_SHAPES]
    if unknown:
        raise ValueError(f'Unknown face shapes {unknown}; the shapes are {", ".join(FACE_SHAPES)}.')
    if any(row not in body.vertex_groups or not _in_group(body, row) for row in TEETH_ROWS):
        raise ValueError('add_face needs the base mesh with its helper geometry, from which it builds the mouth: call it '
                         'in place of bake_targets and bake_modifiers_remove_helpers, not after them.')
    # The body's shape so far becomes its rest shape, so that the face shapes are the only shape keys a game gets.
    if targets.has_any_shapekey(body):
        targets.bake_targets(body)
    face = _Head(body, _rig_weights(services), _mirrors(services))
    if body.data.shape_keys is None:
        body.shape_key_add(name='Basis', from_mix=False)
    for name in names:
        body.shape_key_add(name=name, from_mix=False).data.foreach_set('co', (face.rest + _form(face, FACE_SHAPES[name])).ravel())
    blocks = body.data.shape_keys.key_blocks
    for block in blocks:
        block.value = 0.0
    # A proxy's face is too coarse to fold. MakeHuman's age runs from 0.5 for a young adult to 1 for ninety years.
    if not _fitted(services, body, ('Proxymeshes',)):
        _mark_folds(body, face, float((targets.get_macro_info_dict_from_basemesh(body) or {}).get('age', 0.5)))
    # The helper teeth are read now, while the body still has them: the masks' removal below takes them away.
    teeth = _teeth_rows(body, names)
    tongue = _box(body, TONGUE) if TONGUE in body.vertex_groups else None
    parts = _fitted(services, body, FACE_PARTS)
    # The teeth and the tongue are hard: the upper teeth stay on the skull under every face shape, and the lower
    # teeth and the tongue turn with the jaw. Their share of the jaw's turn is told while they are where MPFB fits them.
    hard, seat, sunk = {}, np.zeros(3), np.zeros(3)
    for part in _fitted(services, body, ('Teeth',)):
        hard[part.name], seat, sunk = _seat_teeth(face, clothes, part)
    for part in _fitted(services, body, ('Tongue',)):
        hard[part.name] = np.ones(len(part.data.vertices))
    # Each soft part takes the shape that MPFB fits it to while one face shape is fully on.
    fitted = {part.name: {} for part in parts}
    for name in names:
        blocks[name].value = 1.0
        for part in parts:
            if part.name not in hard:
                clothes.fit_clothes_to_human(part, body, set_parent=False)
                fitted[part.name][name] = _coords(part)
        blocks[name].value = 0.0
    for part in parts:
        clothes.fit_clothes_to_human(part, body, set_parent=False)
        rest = _coords(part)
        if part.name in hard:
            rest += seat + sunk * hard[part.name][:, None]
            part.data.vertices.foreach_set('co', rest.ravel())
        if part.data.shape_keys is None:
            part.shape_key_add(name='Basis', from_mix=False)
        for name in names:
            if part.name in hard:
                coords = rest + face.turned(rest, FACE_SHAPES[name].get('jaw', 0.0)) * hard[part.name][:, None]
            else:
                coords = fitted[part.name][name]
            # A part that a shape does not move, such as eyelashes under a smile, gets no key for it.
            if np.abs(coords - rest).max() < 2e-5:
                continue
            part.shape_key_add(name=name, from_mix=False).data.foreach_set('co', coords.ravel())
        part.data.update()
    # Masks, with which MPFB hides the helper geometry and clothes hide the skin under them, are applied now, keeping
    # the shape keys: an export that applies modifiers itself drops the shape keys of every mesh that has a mask.
    for mesh in [body, *parts]:
        _apply_masks(mesh)
    proxies = _fitted(services, body, ('Proxymeshes',))
    head = proxies[0] if proxies else body
    mouth = _add_mouth(body, head, teeth, names, own_teeth=not _fitted(services, body, ('Teeth',)),
                       tongue=None if _fitted(services, body, ('Tongue',)) else tongue)
    body['wasd_face'] = True
    return {
        'shapes': names,
        'meshes': {mesh.name: [key.name for key in mesh.data.shape_keys.key_blocks][1:] for mesh in [body, *parts]},
        'mouth': {'mesh': head.name, 'vertices': mouth},
        'eye_bones': _add_eye_bones(services, body) if eye_bones else [],
    }


def export(module, body, path, texture_size=1024):
    """Write a human as a .glb for a game, and return its size and each mesh's triangles.

    The rig goes with every mesh on it, the proxy in place of the base mesh where the human has one. Skin, eyes, teeth,
    and tongue are written solid: MPFB makes every material see-through, and a game then draws a face's inside through
    it. Pictures larger than texture_size pixels are written scaled down to it, and stay as they are in the scene:
    1024 suits a game on the Web, 2048 a face that fills the screen. A body that add_face did not prepare has its
    shape baked in.
    """
    services = importlib.import_module(module + '.services')
    if body is None or not services.ObjectService.object_is_basemesh(body):
        raise ValueError('export takes the base mesh that wasd_mpfb.human or HumanService.create_human returned.')
    rig = body.parent if body.parent is not None and body.parent.type == 'ARMATURE' else None
    if rig is None:
        raise ValueError('export needs a human with a rig: wasd_mpfb.human adds one, or call HumanService.add_builtin_rig.')
    if not body.get('wasd_face') and services.TargetService.has_any_shapekey(body):
        services.TargetService.bake_targets(body)
    proxies = _fitted(services, body, ('Proxymeshes',))
    meshes = [child for child in rig.children if child.type == 'MESH' and not (proxies and child is body)]
    solid = (body, *_fitted(services, body, ('Proxymeshes', 'Eyes', 'Teeth', 'Tongue')))
    small = _fitted(services, body, ('Eyes', 'Teeth', 'Tongue', 'Eyebrows', 'Eyelashes'))
    # Each picture that is written smaller than it is, by the size it is written at, and each node that shows one.
    smaller, shown = {}, []
    for mesh in meshes:
        for slot in mesh.material_slots:
            material = slot.material
            if material is None or not material.use_nodes:
                continue
            if mesh in solid:
                for node in material.node_tree.nodes:
                    if node.type == 'BSDF_PRINCIPLED':
                        for link in list(node.inputs['Alpha'].links):
                            material.node_tree.links.remove(link)
                        node.inputs['Alpha'].default_value = 1.0
            # What is small on the screen, the eyes, the teeth, the tongue, brows, and lashes, needs half the pixels.
            most = max(256, texture_size // 2) if mesh in small else texture_size
            for node in material.node_tree.nodes:
                image = node.image if node.type == 'TEX_IMAGE' else None
                if image is not None and max(image.size) > most:
                    if (image, most) not in smaller:
                        smaller[image, most] = image.copy()
                        smaller[image, most].scale(max(1, round(image.size[0] * most / max(image.size))), max(1, round(image.size[1] * most / max(image.size))))
                        smaller[image, most].pack()
                    shown.append((node, image))
                    node.image = smaller[image, most]
    bpy.ops.object.select_all(action='DESELECT')
    for mesh in meshes:
        mesh.hide_set(False)
        mesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    try:
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                                  export_morph=True, export_morph_normal=True, export_animations=False,
                                  export_vertex_color='ACTIVE')
    finally:
        for node, image in shown:
            node.image = image
        for copy in smaller.values():
            bpy.data.images.remove(copy)
    graph = bpy.context.evaluated_depsgraph_get()
    triangles = {}
    for mesh in meshes:
        shown = mesh.evaluated_get(graph)
        data = shown.to_mesh()
        data.calc_loop_triangles()
        triangles[mesh.name] = len(data.loop_triangles)
        shown.to_mesh_clear()
    return {'bytes': os.path.getsize(path), 'triangles': triangles, 'bones': len(rig.data.bones)}


def _islands(mesh):
    """The parts of a mesh object that no edge joins, each as the indices of its vertices."""
    link = list(range(len(mesh.data.vertices)))

    def root(index):
        while link[index] != index:
            link[index] = link[link[index]]
            index = link[index]
        return index

    for edge in mesh.data.edges:
        link[root(edge.vertices[0])] = root(edge.vertices[1])
    islands = {}
    for index in range(len(link)):
        islands.setdefault(root(index), []).append(index)
    return list(islands.values())


def _coords(mesh):
    """A mesh object's vertex positions as they are now, as an array of rows."""
    coords = np.zeros(len(mesh.data.vertices) * 3)
    mesh.data.vertices.foreach_get('co', coords)
    return coords.reshape(-1, 3)


def _rig_weights(services):
    """The painted weights of MakeHuman's own rig, which MPFB ships: each bone's as {vertex: weight}. They tell which
    skin hangs on the jaw, the lids, and the cheeks, whatever rig the human itself has."""
    import json
    path = os.path.join(os.path.dirname(services.__file__), '..', 'data', 'rigs', 'standard', 'weights.default.json')
    with open(path, encoding='utf-8') as file:
        rows = json.load(file)['weights']
    return {bone: {int(index): float(weight) for index, weight in pairs} for bone, pairs in rows.items()}


def _mirrors(services):
    """Each vertex of MakeHuman's base mesh with its mirror image across the body's middle, from MPFB's own table."""
    path = os.path.join(os.path.dirname(services.__file__), '..', 'data', 'mesh_metadata', 'hm08.mirror')
    with open(path, encoding='utf-8') as file:
        return {int(row[0]): int(row[1]) for row in (line.split() for line in file) if len(row) >= 2}


def _ease(low, high, value):
    """0 at low, 1 at high, and a smooth step between, for arrays."""
    share = np.clip((np.asarray(value, dtype=float) - low) / (high - low), 0.0, 1.0)
    return share * share * (3.0 - 2.0 * share)


class _Head:
    """A human's head for making face shapes: its skin as an elastic sheet. A face shape moves handles, the lips, the
    chin's pad, the cheeks' flesh, and the brows, by rule; the jaw, the lids, and the nose's wings move what
    MakeHuman's rig hangs on them; the skin between follows as a stretched sheet that holds to the nose's ridge, the
    cheekbones, the lid margins, the side of the head, and its own rim; and soft tissue swells where the sheet
    bunches up and sinks where it is stretched, which is what rounds a cheek under a smile and hollows it under
    an open jaw. Each shape is made on the face as it is, so it fits a child's face and an old man's alike."""

    def __init__(self, body, weights, mirrors):
        from collections import defaultdict
        mesh = body.data
        count = len(mesh.vertices)
        rest = np.zeros(count * 3)
        keys = mesh.shape_keys
        (keys.key_blocks['Basis'].data if keys is not None else mesh.vertices).foreach_get('co', rest)
        self.body, self.count, self.rest, self.weights = body, count, rest.reshape(count, 3), weights
        self.skin = np.zeros(count, bool)
        self.skin[_in_group(body, 'body')] = True
        polygons = [list(polygon.vertices) for polygon in mesh.polygons if all(self.skin[index] for index in polygon.vertices)]
        self.neighbors = [[] for _ in range(count)]
        self.edge_faces = defaultdict(set)
        for at, corners in enumerate(polygons):
            for first, second in zip(corners, corners[1:] + corners[:1]):
                self.edge_faces[frozenset((first, second))].add(at)
        for edge in self.edge_faces:
            first, second = tuple(edge)
            self.neighbors[first].append(second)
            self.neighbors[second].append(first)
        self.eyes = {'l': self.rest[_in_group(body, 'helper-l-eye')].mean(axis=0), 'r': self.rest[_in_group(body, 'helper-r-eye')].mean(axis=0)}
        # Every length is for a head whose pupils are 62 mm apart, and scales with the head.
        self.mm = float(np.linalg.norm(self.eyes['l'] - self.eyes['r'])) / 62.0
        # A face leans to one side in what it shows, by about a tenth: which side is this face's own.
        self.lean = 0.11 if zlib.crc32(self.rest.astype(np.float32).tobytes()) & 1 else -0.11
        # The jaw turns about the point where MakeHuman's rig hinges it.
        self.hinge = self.rest[_in_group(body, 'joint-mouth')].mean(axis=0)
        self.jaw = self._bones(JAW_BONES)
        # The mouth: its rings, each from the upper lip's midline toward the character's left, and each spoke's place
        # between the mouth's middle, 0, and its corner, 1.
        # Of a midline vertex's neighbors, the one furthest to the left: a face is not quite its own mirror image, and
        # the neighbors above and below it may lie a hair to the left too.
        toward_left = lambda start: max(self.neighbors[start], key=lambda index: self.rest[index][0])
        self.rings = [self._loop(start, toward_left(start)) for start in LIP_RINGS]
        self.inner = [self._loop(start, toward_left(start)) for start in MOUTH_RINGS]
        line = self.rings[0]
        across = self.rest[line][:, 0]
        left, right = int(np.argmax(across)), int(np.argmin(across))
        self.upper = np.array([spoke <= left or spoke >= right for spoke in range(len(line))])
        self.share = np.clip(across / float(across.max()), -1.0, 1.0)
        self._seal()
        self.spokes = np.stack([self.rest[ring] - self.rest[line] for ring in self.rings])
        # The eyes: rings from the lid margin outward, the right eye's as the mirror image of the left eye's.
        rings = [self._loop(*LID_EDGE)]
        for start in EYE_RINGS[1:]:
            # Each ring runs the way the ring inside it runs, so that their vertices stay in line.
            rings.append(self._loop(start, next(index for index in self.neighbors[start] if index != rings[-1][0] and rings[-1][1] in self.neighbors[index])))
        self.eye_rings = {'l': rings, 'r': [np.array([mirrors[int(index)] for index in ring]) for ring in rings]}
        # How wide the eyes are open, as a share of 35 degrees between the lids' edges seen from the eye's middle:
        # lids turn by that share of a shape's degrees, so that a smile which narrows a wide eye does not shut a
        # narrow one, and a blink closes both.
        edge = self.rest[rings[0]] - self.eyes['l']
        rise = np.degrees(np.arctan2(edge[:, 2], -edge[:, 1]))
        self.open = float(np.clip((rise.max() - rise.min()) / 35.0, 0.5, 1.3))
        # The line of the folds beside the mouth, and the nose's wings.
        line = self._loop(*FOLD_EDGE, closed=False)
        self.folds = {'l': line, 'r': np.array([mirrors[int(index)] for index in line])}
        # How much each of the line's vertices is of the fold beside the mouth, which runs from beside the mouth's
        # corner up to the nose's wing and thins out there.
        self.fold_shares = np.array([0.0] * 6 + [0.25, 0.6] + [1.0] * (len(line) - 12) + [0.9, 0.75, 0.55, 0.35])
        # The rig's weights for the nose's wings stray as far as the ears: only those near the nose's tip count.
        near = np.linalg.norm(self.rest - self.rest[NOSE_RIDGE[4]], axis=1) < 30.0 * self.mm
        self.wings = {side: self._bones((f'levator06.{side.upper()}',)) * near for side in 'lr'}
        self.lid_weights = {(side, part): self._bones((f'orbicularis0{3 if part == "upper" else 4}.{side.upper()}',))
                            for side in 'lr' for part in ('upper', 'lower')}
        # The sheet is the skin of the front of the head.
        head = self._bones([bone for bone in weights if bone.split('.')[0].rstrip('0123456789') in HEAD_BONES])
        self.region = np.flatnonzero(self.skin & (head > 0.5) & (self.rest[:, 1] < self.eyes['l'][1] + 75.0 * self.mm))
        self.place = np.full(count, -1)
        self.place[self.region] = np.arange(len(self.region))
        self._sheet(polygons)
        self._handles()
        self._thickness()
        self._lining()

    def _lining(self):
        """The inside of the mouth, which MakeHuman's mesh has as a pocket behind the lips: each of its vertices with
        the vertex of the face's outside nearest to it, and how closely it follows that one. A cheek and a lip are
        slabs whose inside goes where their outside goes; a pocket that stayed behind would come out through a
        cheek that an opening jaw draws in."""
        from mathutils import kdtree
        lips = set(self.lips)
        skin = np.flatnonzero(self.skin)
        tree = kdtree.KDTree(len(skin))
        for at, index in enumerate(skin):
            tree.insert(self.rest[index], at)
        tree.balance()
        pocket, edge = set(), [int(index) for index in self.inner[1]]
        while edge:
            index = edge.pop()
            for other in self.neighbors[index]:
                if other not in lips and other not in pocket:
                    pocket.add(other)
                    edge.append(other)
        self.pocket = np.array(sorted(pocket & set(self.region.tolist())), dtype=int)
        outside, follows = [], []
        for index in self.pocket:
            # A vertex deep in the pocket has none of the face's outside among its nearest, and follows nothing.
            found = next(((int(skin[at]), distance) for _, at, distance in tree.find_n(self.rest[index], 24)
                          if int(skin[at]) not in pocket and int(skin[at]) not in lips), (int(index), 1.0))
            outside.append(found[0])
            follows.append(found[1])
        self.outside = np.array(outside, dtype=int)
        self.follows = _ease(9.0 * self.mm, 3.0 * self.mm, np.array(follows))

    def _bones(self, names):
        """The sum of some bones' weights, for every vertex."""
        field = np.zeros(self.count)
        for bone in names:
            for index, weight in self.weights.get(bone, {}).items():
                field[index] += weight
        return field

    def _loop(self, first, second, closed=True):
        """The edge loop that starts with the edge from one vertex to the next: a closed one, or one that ends
        where the mesh's lines do not go straight on."""
        loop = [first, second]
        while True:
            before, here = loop[-2], loop[-1]
            around = self.neighbors[here]
            came = self.edge_faces[frozenset((before, here))]
            onward = [index for index in around if index != before and not self.edge_faces[frozenset((here, index))] & came]
            if len(around) != 4 or len(onward) != 1 or len(loop) > 200:
                if not closed and len(loop) > 8:
                    return np.array(loop, dtype=int)
                raise ValueError('add_face needs MakeHuman\'s own base mesh: this mesh has other edges round the mouth and the eyes.')
            if onward[0] == first:
                return np.array(loop, dtype=int)
            loop.append(onward[0])

    def _seal(self):
        """Close the lips. MakeHuman's lips stand up to a millimeter and a half apart at rest, and the mouth's dark
        inside shows between them as the line of the mouth; teeth that sit where teeth sit would show there as a white
        line. The lower lip's edge is lifted to the upper lip's, the rings under it by less."""
        line = self.rings[0]
        above = line[self.upper]
        above = above[np.argsort(self.rest[above][:, 0])]
        for spoke in np.flatnonzero(~self.upper):
            index = line[spoke]
            gap = float(np.interp(self.rest[index][0], self.rest[above][:, 0], self.rest[above][:, 2])) - self.rest[index][2] + 0.15 * self.mm
            if gap > 0.0:
                for ring, share in ((line, 1.0), (self.rings[1], 0.6), (self.rings[2], 0.3), (self.rings[3], 0.1), (self.inner[0], 1.0), (self.inner[1], 1.0)):
                    self.rest[ring[spoke]][2] += gap * share
        mesh = self.body.data
        mesh.vertices.foreach_set('co', self.rest.ravel())
        if mesh.shape_keys is not None:
            mesh.shape_keys.key_blocks['Basis'].data.foreach_set('co', self.rest.ravel())
        mesh.update()

    def _sheet(self, polygons):
        """The sheet's stiffness between its vertices, from the cotangents of its triangles' corners, each vertex's
        area, and each vertex's normal."""
        points = self.rest[self.region]
        rows, shares = [], []
        for corners in polygons:
            local = self.place[corners]
            if (local < 0).any():
                continue
            if len(corners) == 3:
                rows.append(local)
                shares.append(1.0)
            elif len(corners) == 4:
                # A quad as both of its splits, half each, so that neither diagonal is favored.
                a, b, c, d = local
                rows += [(a, b, c), (a, c, d), (a, b, d), (b, c, d)]
                shares += [0.5] * 4
        self.triangles, self.shares = np.array(rows, dtype=int), np.array(shares)
        triangles = self.triangles
        matrix = np.zeros((len(points), len(points)))
        for first, second, third in ((0, 1, 2), (1, 2, 0), (2, 0, 1)):
            # The cotangent of the corner at `third` weighs the edge opposite to it.
            one = points[triangles[:, first]] - points[triangles[:, third]]
            other = points[triangles[:, second]] - points[triangles[:, third]]
            cotangent = (one * other).sum(axis=1) / np.maximum(np.linalg.norm(np.cross(one, other), axis=1), 1e-12)
            weight = np.clip(cotangent, 0.02, 20.0) * 0.5 * self.shares
            np.add.at(matrix, (triangles[:, first], triangles[:, second]), -weight)
            np.add.at(matrix, (triangles[:, second], triangles[:, first]), -weight)
            np.add.at(matrix, (triangles[:, first], triangles[:, first]), weight)
            np.add.at(matrix, (triangles[:, second], triangles[:, second]), weight)
        self.matrix = matrix
        self.area = self._areas(points)
        mean = -matrix
        np.fill_diagonal(mean, 0.0)
        self.mean = mean / np.maximum(mean.sum(axis=1, keepdims=True), 1e-12)
        each = np.cross(points[triangles[:, 1]] - points[triangles[:, 0]], points[triangles[:, 2]] - points[triangles[:, 0]]) * self.shares[:, None]
        normals = np.zeros_like(points)
        for corner in range(3):
            np.add.at(normals, triangles[:, corner], each)
        self.normals = normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)

    def _areas(self, points):
        """Each sheet vertex's share of the area of the triangles round it, with the sheet's vertices at some points."""
        triangles = self.triangles
        each = 0.5 * np.linalg.norm(np.cross(points[triangles[:, 1]] - points[triangles[:, 0]], points[triangles[:, 2]] - points[triangles[:, 0]]), axis=1) * self.shares
        area = np.zeros(len(points))
        for corner in range(3):
            np.add.at(area, triangles[:, corner], each / 3.0)
        return area

    def _near(self, sources, reach):
        """The vertices within reach of some vertices, along the skin's edges."""
        import heapq
        distance = {int(index): 0.0 for index in sources}
        heap = [(0.0, int(index)) for index in sources]
        while heap:
            here, index = heapq.heappop(heap)
            if here > distance[index]:
                continue
            for other in self.neighbors[index]:
                there = here + float(np.linalg.norm(self.rest[index] - self.rest[other]))
                if there < reach and there < distance.get(other, reach):
                    distance[other] = there
                    heapq.heappush(heap, (there, other))
        return distance

    def _handles(self):
        """Solve the sheet once for every vertex that a rule moves or that holds to the bone: afterwards any face
        shape is one multiplication."""
        inside = set(self.region.tolist())
        self.lips = [int(index) for ring in self.rings + self.inner for index in ring]
        self.chin = sorted(set(self._near(CHIN_PAD, 8.0 * self.mm)) & inside)
        nose = set(self._near(NOSE_RIDGE, 7.0 * self.mm))
        held = nose | set(self._near(CHEEKBONES, 8.0 * self.mm))
        self.brows = {}
        for side in 'lr':
            rings = self.eye_rings[side]
            # The lid margin and the ring next to it follow the lid alone; the brow is the three outer rings above the
            # eye, short of the skin that holds to the nose's bridge.
            held |= set(rings[0].tolist()) | set(rings[1].tolist())
            top = float(self.rest[rings[0]][:, 2].max())
            self.brows[side] = [int(index) for ring in rings[6:9] for index in ring if self.rest[index][2] > top and index not in nose]
        # The flesh of each cheek, round the point under the eye's outer half at the height of the nose's wings.
        self.cheeks = {}
        for side, sign in (('l', 1.0), ('r', -1.0)):
            lid = self.rest[self.eye_rings[side][0]]
            corner = self.rest[self.rings[0][int(np.argmax(self.rest[self.rings[0]][:, 0] * sign))]]
            point = lid[int(np.argmin(lid[:, 2]))] * 0.45 + corner * 0.55 + np.array([sign * 10.0 * self.mm, 0.0, 0.0])
            apex = int(self.region[int(np.argmin(np.linalg.norm(self.rest[self.region] - point, axis=1)))])
            self.cheeks[side] = sorted((set(self._near([apex], 9.0 * self.mm)) - held) & inside)
        # The sheet's rim holds to the skin beyond it, which no face shape moves: a rim that went with the sheet
        # would leave a step under the jaw and round the head.
        self.rim = {int(index) for index in self.region if any(self.skin[other] and other not in inside for other in self.neighbors[int(index)])}
        held |= self.rim
        self.chin = sorted(set(self.chin) - held)
        for side in 'lr':
            self.brows[side] = [index for index in self.brows[side] if index not in self.rim]
            self.cheeks[side] = [index for index in self.cheeks[side] if index not in self.rim]
        moved = set(self.lips) | set(self.chin) | set(self.brows['l']) | set(self.brows['r']) | set(self.cheeks['l']) | set(self.cheeks['r'])
        self.handles = np.array(sorted((moved | held) & inside), dtype=int)
        self.where = {int(index): at for at, index in enumerate(self.handles)}
        self.held = self.place[self.handles]
        mask = np.zeros(len(self.region), bool)
        mask[self.held] = True
        self.free = np.flatnonzero(~mask)
        # The skin slides freely over the cheeks and round the mouth, and holds to the side of the head: a spring to
        # each vertex's place at rest, stiff where the way a pull fades is short.
        fade = np.full(len(self.region), 60.0 * self.mm)
        fade[self.rest[self.region][:, 1] > self.eyes['l'][1] + 12.0 * self.mm] = 12.0 * self.mm
        stiffness = self.matrix[np.ix_(self.free, self.free)]
        # The least bit more keeps a vertex at the sheet's rim that no triangle of the sheet holds from having no equation.
        stiffness[np.arange(len(self.free)), np.arange(len(self.free))] += self.area[self.free] / fade[self.free] ** 2 + 1e-8
        self.answer = np.linalg.solve(stiffness, -self.matrix[np.ix_(self.free, self.held)])

    def _thickness(self):
        """How thick the soft tissue under the skin is: the cheeks' fat most, then the lips, and little over bone;
        and where the swelling is held back, on the lips' edges, which must stay shut."""
        cheeks = np.clip(self._bones(CHEEK_BONES) + 0.5 * self._bones(('levator06.L', 'levator06.R')), 0.0, 1.0)
        beyond = np.full(self.count, 8.0 * self.mm)
        for index, distance in self._near(self.rings[7], 8.0 * self.mm).items():
            beyond[index] = distance
        beyond[self.lips] = 0.0
        thick = 2.0 + 13.0 * _ease(0.1, 0.6, cheeks) * _ease(1.5 * self.mm, 8.0 * self.mm, beyond)
        hold = np.ones(self.count)
        for at, ring in enumerate(self.rings):
            thick[ring] += 5.0 * (1.0 - 0.5 * at / 7.0)
            hold[ring] = min(1.0, at / 3.0)
        for ring in self.inner:
            hold[ring] = 0.0
        # The lid margins follow the lids alone, so that lashes stay on them and the eyes' opening is what a shape says.
        for side in 'lr':
            hold[self.eye_rings[side][0]] = 0.0
            hold[self.eye_rings[side][1]] = 0.0
        hold[sorted(self.rim)] = 0.0
        self.thick, self.hold = thick * self.mm, hold

    def shut(self, side):
        """How far every vertex moves when one eye closes. The lower lid rises a little, and the upper lid comes down
        to it and a little over it, by as much as it takes at each place along the lid: a lid that turned as one
        piece would meet the lower lid in the eye's middle and leave its white to show beside it, more on one face
        than on another."""
        edge = self.eye_rings[side][0]
        upper, lower = self.lid_weights[side, 'upper'], self.lid_weights[side, 'lower']
        offset = self.rest[edge] - self.eyes[side]
        rise = np.degrees(np.arctan2(offset[:, 2], -offset[:, 1]))
        across = self.rest[edge][:, 0]
        above, below = upper[edge] > lower[edge], (lower[edge] >= upper[edge]) & (lower[edge] > 0.3)
        lifted = 5.0 * self.open
        order = np.argsort(across[below])
        # Where the lower lid's edge stands once it has risen, under each point of the upper lid's edge.
        meets = np.interp(across[above], across[below][order], (rise[below] + lifted * lower[edge][below])[order])
        # The upper lid's edge moves by its weight's share of its turn: the turn that takes it down to the lower lid's
        # edge and a degree and a half over it. Toward the eye's corners, where the lid hardly moves, it turns no
        # further than a quarter more than its middle does, or the lashes there would swing down the cheek.
        needed = (rise[above] - meets + 1.5) / np.maximum(upper[edge][above], 0.35)
        middle = float(np.median(needed[upper[edge][above] > 0.8])) if (upper[edge][above] > 0.8).any() else float(np.median(needed))
        needed = np.clip(needed, 0.0, 1.25 * middle)
        order = np.argsort(across[above])
        turn = np.radians(np.interp(self.rest[:, 0], across[above][order], needed[order]))
        offset = self.rest - self.eyes[side]
        down = np.zeros_like(self.rest)
        down[:, 1] = offset[:, 1] * np.cos(turn) - offset[:, 2] * np.sin(turn) - offset[:, 1]
        down[:, 2] = offset[:, 1] * np.sin(turn) + offset[:, 2] * np.cos(turn) - offset[:, 2]
        return down * upper[:, None] + self.turned(self.rest, -lifted, self.eyes[side]) * lower[:, None]

    def turned(self, points, degrees, about=None):
        """How far some points move when they turn about a left-to-right axis through the jaw's hinge, or through
        another point; a positive angle takes what lies in front of the point down, as an opening jaw goes."""
        if not degrees:
            return np.zeros_like(points)
        angle = math.radians(degrees)
        offset = points - (self.hinge if about is None else about)
        turned = offset.copy()
        turned[:, 1] = offset[:, 1] * math.cos(angle) - offset[:, 2] * math.sin(angle)
        turned[:, 2] = offset[:, 1] * math.sin(angle) + offset[:, 2] * math.cos(angle)
        return turned - offset

    def lip_moves(self, whole, edge, thin, moves, lean=0.0):
        """Add the lips' moves under two rules(share, upper) -> (to the side, back, up), in mm, of each spoke's vertex
        on the line where the lips meet; share runs from 0 at the mouth's middle to 1 at its corner. Under `whole`
        every ring takes its spoke's move, as a mouth's corner takes the whole lip with it; under `edge` the rings
        take less the farther they lie from that line, as a lip's edge lifts while its root stays under the nose; and
        thin draws the (upper, lower) lip thinner toward that line. lean has the character's left side do more than
        its right, or less."""
        for spoke, share in enumerate(self.share):
            upper, sign = bool(self.upper[spoke]), np.array([float(np.sign(share)), 1.0, 1.0])
            all_of_it = np.array(whole(abs(share), upper)) * sign * self.mm * (1.0 + lean * share)
            its_edge = np.array(edge(abs(share), upper)) * sign * self.mm * (1.0 + lean * share)
            taper = (thin[0] if upper else thin[1]) * (1.0 - float(_ease(0.8, 1.0, abs(share))))
            for at, ring in enumerate(self.rings):
                moves[ring[spoke]] = moves.get(ring[spoke], 0.0) + all_of_it + its_edge * (1.0 - 0.65 * at / 7.0) - self.spokes[at][spoke] * taper
            for ring in self.inner:
                moves[ring[spoke]] = moves.get(ring[spoke], 0.0) + all_of_it + its_edge

    def shape(self, jaw, lids, moves, nostrils=(0.0, 0.0), fold=0.0, lean=0.0, shut=''):
        """A face shape as every vertex's displacement: the jaw opened by some degrees, the lids turned about their
        eyes, {(side, part): degrees}, the eyes of some sides shut, the handles moved, {vertex: displacement}, the
        nose's wings drawn (to the side, up), the sheet between all of them, the swelling, and the skin sunk by some
        mm along the fold beside the mouth."""
        base = self.turned(self.rest, jaw) * self.jaw[:, None]
        for side in shut:
            base += self.shut(side)
        for side, sign in (('l', 1.0), ('r', -1.0)):
            base += self.wings[side][:, None] * np.array([sign * nostrils[0], 0.0, nostrils[1]]) * self.mm * (1.0 + lean * sign)
        for (side, part), degrees in lids.items():
            base += self.turned(self.rest, degrees if part == 'upper' else -degrees, self.eyes[side]) * self.lid_weights[side, part][:, None]
        given = np.zeros((len(self.handles), 3))
        for index, move in moves.items():
            if int(index) in self.where:
                given[self.where[int(index)]] = move
        sheet = np.zeros((len(self.region), 3))
        sheet[self.held] = given
        sheet[self.free] = self.answer @ given
        base[self.region] += sheet
        # Soft tissue keeps its volume: where the skin loses a share of its area, the tissue under it rises by that
        # share of its thickness, and where the skin is stretched, it sinks.
        ratio = self._areas(self.rest[self.region] + base[self.region]) / np.maximum(self.area, 1e-12)
        hold = self.hold[self.region]
        rise = self.thick[self.region] * np.clip(1.0 - ratio, -0.4, 0.4) * hold
        for _ in range(2):
            rise = (rise * 0.4 + (self.mean @ rise) * 0.6) * hold
        base[self.region] += self.normals * rise[:, None]
        for side, sign in (('l', 1.0), ('r', -1.0)):
            for index, share in zip(self.folds[side], self.fold_shares):
                base[index] -= self.normals[self.place[index]] * fold * share * self.mm * (1.0 + lean * sign)
        base[self.pocket] += (base[self.outside] - base[self.pocket]) * self.follows[:, None]
        return base

    def fold_lines(self):
        """Where this face folds, as lines of vertices, each with how deep its groove is in mm at each vertex and how
        wide in mm: a smile's, from the nose's wing to beside the mouth's corner, out of each corner of the mouth, and
        under each lower lid; and a frown's, two between the brows and one over the chin."""
        smile, frown = [], []
        ridge = self.rest[NOSE_RIDGE[-1]]
        for side, sign in (('l', 1.0), ('r', -1.0)):
            line = self.folds[side]
            smile.append((line[6:], self.fold_shares[6:], 1.3))
            corner = int(np.argmax(self.share * sign))
            smile.append((np.array([ring[corner] for ring in self.rings[1:8]]), np.array([0.2, 0.45, 0.6, 0.6, 0.5, 0.35, 0.15]), 1.0))
            # Under the lower lid, from under the eye's middle outward.
            ring = self.eye_rings[side][3]
            low = self.rest[ring][:, 2] < self.eyes[side][2] - 1.0 * self.mm
            outer = np.abs(self.rest[ring][:, 0]) > abs(self.eyes[side][0]) - 4.0 * self.mm
            under = ring[low & outer]
            under = under[np.argsort(np.abs(self.rest[under][:, 0]))]
            smile.append((under, np.full(len(under), 0.4) * np.linspace(0.6, 1.0, len(under)), 0.9))
            # Between the brows, a finger's width from the middle, from the nose's root up: the sheet's vertices
            # nearest to that line at four heights.
            points = self.rest[self.region]
            ahead = np.where(points[:, 1] < ridge[1] + 15.0 * self.mm, 0.0, 1.0)
            knit = []
            for height in (2.0, 6.0, 10.0, 14.0):
                aim = np.array([sign * 5.5 * self.mm, 0.0, ridge[2] + height * self.mm])
                knit.append(int(self.region[int(np.argmin(np.abs(points[:, 0] - aim[0]) + np.abs(points[:, 2] - aim[2]) + ahead))]))
            knit = np.array(list(dict.fromkeys(knit)))
            frown.append((knit, np.linspace(0.9, 0.5, len(knit)), 1.0))
        chin = np.concatenate([self.folds['l'][3::-1], self.folds['r'][1:4]])
        frown.append((chin, np.array([0.25, 0.5, 0.6, 0.6, 0.6, 0.5, 0.25]), 1.5))
        return smile, frown


def _form(head, recipe):
    """A face shape of FACE_SHAPES as every vertex's displacement on a head."""
    lean = head.lean * recipe.get('lean', 0.0)
    # What takes the whole lip with it, and what moves a lip's edge more than its root.
    whole, edge = [], []
    if 'pull' in recipe:
        side, back, up = recipe['pull']
        # A smile's line is flat in the middle and lifts toward the corners, which go back round the teeth.
        whole.append(lambda share, upper, side=side, back=back, up=up: (side * share, back * share ** 2, up * share ** 1.7))
    if 'sink' in recipe:
        side, down = recipe['sink']
        whole.append(lambda share, upper, side=side, down=down: (side * share, 0.0, -down * share ** 2.2))
    if 'stretch' in recipe:
        side, back, down = recipe['stretch']
        whole.append(lambda share, upper, side=side, back=back, down=down: (side * share, back * share ** 2, -down * share ** 2))
    if 'purse' in recipe:
        inward, forward, part = recipe['purse']
        whole.append(lambda share, upper, inward=inward: (-inward * share, 0.0, 0.0))
        edge.append(lambda share, upper, forward=forward, part=part: (0.0, -forward * (1.0 - share ** 2), -part * (1.0 if upper else 0.5) * (1.0 - share ** 2)))
    if 'narrow' in recipe:
        whole.append(lambda share, upper: (-recipe['narrow'] * share ** 1.5, 0.0, 0.0))
    if 'lift' in recipe:
        # The lip lifts most over the front teeth and less toward the corners, where it still covers the teeth's tops.
        edge.append(lambda share, upper: (0.0, 0.0, recipe['lift'] * (1.0 - share ** 2.2) if upper else 0.0))
    if 'drop' in recipe:
        edge.append(lambda share, upper: (0.0, 0.0, 0.0 if upper else -recipe['drop'] * (1.0 - share ** 2.5)))
    moves = {}
    if 'push' in recipe:
        up, forward = recipe['push']
        # The chin pushes the lower lip up in its middle, and the upper lip gives way to it by a third.
        whole.append(lambda share, upper, up=up, forward=forward:
                     (0.0, -forward * (1.0 - share ** 2) * (0.3 if upper else 1.0), up * (1.0 - share ** 2) * (0.35 if upper else 1.0)))
        for index in head.chin:
            moves[index] = np.array([0.0, -0.6 * forward, 1.2 * up]) * head.mm
    if whole or edge or 'thin' in recipe:
        both = lambda rules: lambda share, upper: tuple(sum(parts) for parts in zip((0.0, 0.0, 0.0), *(rule(share, upper) for rule in rules)))
        head.lip_moves(both(whole), both(edge), recipe.get('thin', (0.0, 0.0)), moves, lean)
    if 'cheeks' in recipe:
        side, forward, up = recipe['cheeks']
        for name, sign in (('l', 1.0), ('r', -1.0)):
            for index in head.cheeks[name]:
                moves[index] = np.array([sign * side, -forward, up]) * head.mm * (1.0 + lean * sign)
    if 'brows' in recipe:
        inner, outer, inward, forward = recipe['brows']
        for side, sign in (('l', 1.0), ('r', -1.0)):
            across = np.abs(head.rest[head.brows[side]][:, 0])
            # The brow's move fades over the 5 mm next to the nose's bridge, where the skin bunches but does not tear.
            fades = _ease(across.min(), across.min() + 5.0 * head.mm, across)
            for index, place, fade in zip(head.brows[side], (across - across.min()) / (across.max() - across.min()), fades):
                up = inner * (1.0 - place) ** 1.5 + outer * float(_ease(0.1, 0.9, place))
                moves[index] = np.array([-sign * inward * (1.0 - place), -forward * (1.0 - place), up]) * head.mm * (0.25 + 0.75 * fade) * (1.0 + lean * sign)
    lids = recipe.get('lids', (0.0, 0.0))
    lids = {side: lids for side in 'lr'} if isinstance(lids, tuple) else lids
    extra = {'nostrils': recipe.get('nostrils', (0.0, 0.0)), 'fold': recipe.get('fold', 0.0), 'lean': lean, 'shut': recipe.get('shut', '')}
    # The lids take half the lean: an eye that closes more than the other winks.
    turns = {(side, part): degrees * head.open * (1.0 + 0.5 * lean * (1.0 if side == 'l' else -1.0))
             for side, pair in lids.items() for part, degrees in zip(('upper', 'lower'), pair) if degrees}
    return head.shape(recipe.get('jaw', 0.0), turns, moves, **extra)


def _mark_folds(body, head, age=0.5):
    """Tell a game where this face folds and how. A mesh this coarse cannot fold, and a smile without its folds lies
    on a face like a decal. The skin's material gets a normal map of the grooves that a smile and a frown press into
    this face, shallow on a child's and deep on an old one's, with how deep each groove is in its blue besides. The
    map's strength is 0, so that a material that knows nothing of it shows a smooth face, and not one that smiles
    and frowns at once. And the body gets a second UV map, wasd_folds, whose U is how much each vertex lies where a
    smile folds the face and whose V, counted down from 1 as glTF turns it, where a frown does: the skin of the
    wasd-materials add-on presses the grooves in there by as much as wasd-face says the face smiles or frowns."""
    mesh = body.data
    material = body.material_slots[0].material if body.material_slots else None
    first = mesh.uv_layers.active
    if first is None or material is None or not material.use_nodes:
        return
    name = first.name
    size = 1024
    corners = np.zeros(len(mesh.loops), dtype=int)
    mesh.loops.foreach_get('vertex_index', corners)
    spread = np.zeros(len(mesh.loops) * 2)
    first.data.foreach_get('uv', spread)
    # Each vertex's place in the skin's picture: no fold runs along a seam of the map.
    place = np.zeros((head.count, 2))
    place[corners] = spread.reshape(-1, 2) * size - 0.5
    deeper = min(max(0.75 + 1.8 * (age - 0.5), 0.45), 1.7)
    # How deep the grooves are at each point of the picture, in its own pixels and in meters.
    depth = np.zeros((size, size), dtype=np.float32)
    sunk = np.zeros((size, size), dtype=np.float32)
    marks = [np.zeros(head.count), np.zeros(head.count)]
    for group, lines in enumerate(head.fold_lines()):
        for line, deep, wide in lines:
            if len(line) < 2:
                continue
            near = head._near(line, 9.0 * head.mm)
            for index, distance in near.items():
                marks[group][index] = max(marks[group][index], float(1.0 - _ease(4.0 * head.mm, 9.0 * head.mm, distance)))
            # How many pixels a meter of this line is, to draw its groove as wide as it is on the face.
            length = sum(float(np.linalg.norm(head.rest[b] - head.rest[a])) for a, b in zip(line, line[1:]))
            drawn = sum(float(np.linalg.norm(place[b] - place[a])) for a, b in zip(line, line[1:]))
            scale = drawn / max(length, 1e-6)
            width = max(wide * head.mm * scale, 1.0)
            for (a, b), (deep_a, deep_b) in zip(zip(line, line[1:]), zip(deep, deep[1:])):
                (ax, ay), (bx, by) = place[a], place[b]
                reach = int(width * 3.5) + 2
                left, right = max(int(min(ax, bx)) - reach, 0), min(int(max(ax, bx)) + reach + 1, size)
                low, high = max(int(min(ay, by)) - reach, 0), min(int(max(ay, by)) + reach + 1, size)
                if left >= right or low >= high:
                    continue
                ys, xs = np.mgrid[low:high, left:right]
                along = np.clip(((xs - ax) * (bx - ax) + (ys - ay) * (by - ay)) / max((bx - ax) ** 2 + (by - ay) ** 2, 1e-9), 0.0, 1.0)
                away = (xs - ax - along * (bx - ax)) ** 2 + (ys - ay - along * (by - ay)) ** 2
                groove = (deep_a + (deep_b - deep_a) * along) * deeper * head.mm * np.exp(-away / (2.0 * width * width))
                depth[low:high, left:right] = np.maximum(depth[low:high, left:right], groove * scale)
                sunk[low:high, left:right] = np.maximum(sunk[low:high, left:right], groove)
    # The slope of the depth in pixels is the tilt of the skin's normal. Rows run upward, as Blender's pictures
    # do, and a groove goes into the skin.
    up, across = np.gradient(-depth)
    tilt = np.stack([-across, -up, np.ones_like(depth)], axis=-1)
    tilt /= np.linalg.norm(tilt, axis=-1, keepdims=True)
    # The blue is the normal's own, shortened by up to a half where a groove is a millimeter and a half deep: a
    # material that reads normals makes it whole again, and the skin's reads the groove's depth from what is missing.
    tilt[..., 2] *= 1.0 - 0.5 * np.clip(sunk / (1.5 * head.mm), 0.0, 1.0)
    picture = bpy.data.images.new(f'{body.name}.skin_folds', size, size, alpha=False)
    picture.colorspace_settings.name = 'Non-Color'
    _keep(picture, np.concatenate([tilt * 0.5 + 0.5, np.ones((size, size, 1))], axis=-1).astype(np.float32))
    tree = material.node_tree
    shader = next((node for node in tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
    if shader is not None:
        texture = tree.nodes.new('ShaderNodeTexImage')
        texture.image = picture
        bump = tree.nodes.new('ShaderNodeNormalMap')
        bump.inputs['Strength'].default_value = 0.0
        tree.links.new(texture.outputs['Color'], bump.inputs['Color'])
        tree.links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    layer = mesh.uv_layers.get('wasd_folds') or mesh.uv_layers.new(name='wasd_folds', do_init=False)
    layer.data.foreach_set('uv', np.stack([marks[0][corners], 1.0 - marks[1][corners]], axis=1).ravel())
    # The skin's own map stays the one that pictures and the export use first.
    mesh.uv_layers.active = mesh.uv_layers[name]
    mesh.uv_layers[name].active_render = True


def _seat_teeth(head, clothes, teeth):
    """Each vertex's share in the jaw's turn for a teeth asset, how far to move the asset to where teeth sit, and
    how far to move what turns with the jaw besides. MakeHuman seats its teeth some three millimeters too high and
    four too deep behind the lips: its lower teeth stand above the lower lip, so an opening jaw bares the whole
    lower row, as a skull's does, and its upper teeth hide behind the upper lip. Teeth sit with the upper front
    teeth's edge two millimeters under the upper lip's, where a mouth that opens shows them first, and close behind
    the lips; the lower row sits a little lower still, so that its tips stay behind the lower lip and do not notch
    the lip's edge as the mouth opens."""
    body = head.body
    clothes.fit_clothes_to_human(teeth, body, set_parent=False)
    rest = _coords(teeth)
    # What hangs on the jaw is what MPFB fitted to the lower row of the base mesh's helper teeth: it is what moves
    # when that row alone is pushed back. The teeth's heights do not tell: a back tooth of the lower row stands
    # higher than a front tooth of the upper row hangs.
    if body.data.shape_keys is None:
        body.shape_key_add(name='Basis', from_mix=False)
    probe = body.shape_key_add(name='wasd-probe', from_mix=False)
    for index in _in_group(body, TEETH_ROWS[1]):
        probe.data[index].co.y += 0.005
    probe.value = 1.0
    clothes.fit_clothes_to_human(teeth, body, set_parent=False)
    share = np.clip((_coords(teeth) - rest)[:, 1] / 0.005, 0.0, 1.0)
    body.shape_key_remove(probe)
    clothes.fit_clothes_to_human(teeth, body, set_parent=False)
    # Each tooth is an island of the mesh and hard: all of it goes with the jaw or none of it. The gums are one
    # large island that stretches at the back of the mouth, between what goes and what stays.
    upper = []
    for island in _islands(teeth):
        if len(island) < 0.2 * len(rest):
            share[island] = round(float(share[island].mean()))
            if share[island[0]] < 0.5 and np.abs(rest[island][:, 0]).min() < 4.5 * head.mm:
                upper += island
    if not upper:
        return share, np.zeros(3), np.zeros(3)
    edge, deep = float(rest[upper][:, 2].min()), float(rest[upper][:, 1].min())
    seat = np.array([0.0, -min(max(deep - (float(head.rest[MOUTH_RINGS[1]][1]) + 2.2 * head.mm), 0.0), 6.0 * head.mm),
                     -min(max(edge - (float(head.rest[LIP_RINGS[0]][2]) - 2.0 * head.mm), 0.0), 6.0 * head.mm)])
    return share, seat, np.array([0.0, 0.0, -1.2 * head.mm])


def _in_group(mesh, name):
    """The indices of a mesh's vertices that belong to a vertex group."""
    group = mesh.vertex_groups[name].index
    return [vertex.index for vertex in mesh.data.vertices if any(entry.group == group and entry.weight > 0.5 for entry in vertex.groups)]


def _box(mesh, name):
    """The box round a vertex group of a mesh at rest, as its lowest and its highest corner; none for an empty group."""
    from mathutils import Vector
    inside = [mesh.data.vertices[index].co for index in _in_group(mesh, name)]
    if not inside:
        return None
    return (Vector([min(point[axis] for point in inside) for axis in range(3)]),
            Vector([max(point[axis] for point in inside) for axis in range(3)]))


def _ball(segments, rings):
    """A ball of radius 1 whose poles lie on the Y axis: its points, and its faces wound to face outward."""
    from mathutils import Vector
    points = [Vector((0.0, -1.0, 0.0))]
    for ring in range(1, rings):
        down = math.pi * ring / rings
        for segment in range(segments):
            around = 2.0 * math.pi * segment / segments
            # A ball with its poles on Z, turned a quarter about X, which keeps its faces' winding.
            points.append(Vector((math.sin(down) * math.cos(around), -math.cos(down), math.sin(down) * math.sin(around))))
    points.append(Vector((0.0, 1.0, 0.0)))
    last = len(points) - 1
    faces = []
    for segment in range(segments):
        after = (segment + 1) % segments
        faces.append([0, 1 + segment, 1 + after])
        for ring in range(rings - 2):
            here, below = 1 + ring * segments, 1 + (ring + 1) * segments
            faces.append([here + segment, below + segment, below + after, here + after])
        faces.append([last, last - segments + after, last - segments + segment])
    return points, faces


def _teeth_rows(body, names):
    """The base mesh's two rows of helper teeth: each row's faces, as indices into its points, and its points at rest
    and under each face shape, in the body's own space."""
    blocks = body.data.shape_keys.key_blocks
    rows = []
    for row in TEETH_ROWS:
        inside = _in_group(body, row)
        place = {index: at for at, index in enumerate(inside)}
        rows.append({
            'faces': [[place[index] for index in polygon.vertices] for polygon in body.data.polygons
                      if all(index in place for index in polygon.vertices)],
            'points': {name: [blocks[name].data[index].co.copy() for index in inside] for name in ['Basis', *names]},
        })
    return rows


def _mouth_rim(data, front, reach):
    """The rim of a head's mouth where the mouth is a hole, as a low-poly proxy's is: the vertices, in their order
    round the hole, of the open edge whose middle lies nearest to the front teeth and within reach of them. None for
    a head whose mouth is closed inside, as the base mesh's is."""
    from mathutils import Vector
    best, nearest, seen = None, reach, set()
    for first in data.edges:
        if not first.is_boundary or first in seen:
            continue
        loop, vertex, edge = [], first.verts[0], first
        while edge is not None:
            seen.add(edge)
            loop.append(vertex)
            vertex = edge.other_vert(vertex)
            edge = next((other for other in vertex.link_edges if other.is_boundary and other not in seen), None)
        away = (sum((point.co for point in loop), Vector()) / len(loop) - front).length
        # An open edge that does not come back to its start is not a hole's rim.
        if vertex is loop[0] and len(loop) >= 3 and away < nearest:
            best, nearest = loop, away
    return best


def _add_mouth(body, head, teeth, names, own_teeth, tongue):
    """Give the mesh that shows the head the inside of a mouth, and return how many vertices that added.

    A proxy's mouth is a hole in a shell: it is closed from behind with a dark pocket whose rim is the hole's own, so
    that no view through the lips passes it. Unless the human has MPFB's teeth, the head also gets the two rows of
    teeth that the base mesh carries as helper geometry, and, unless it has MPFB's tongue, a tongue in the place of
    the base mesh's helper one. All of it takes the face shapes: the pocket opens with the lips, and the lower row
    and the tongue follow the jaw.
    """
    import bmesh
    from mathutils import Vector
    upper, lower = teeth
    rest = upper['points']['Basis'] + lower['points']['Basis']
    low = Vector([min(point[axis] for point in rest) for axis in range(3)])
    high = Vector([max(point[axis] for point in rest) for axis in range(3)])
    middle, half = (low + high) / 2.0, (high - low) / 2.0
    to_head = head.matrix_world.inverted() @ body.matrix_world
    rig = body.parent if body.parent is not None and body.parent.type == 'ARMATURE' else None
    bone = next((name for name in ('head', 'Head', 'mixamorig:Head') if rig is not None and name in rig.data.bones), None)
    group = None if bone is None else (head.vertex_groups.get(bone) or head.vertex_groups.new(name=bone)).index
    before = len(head.data.vertices)

    def slot(kind):
        """A new material slot of the head's mesh for a part of the inside."""
        color, roughness, metallic = MOUTH_MATERIALS[kind]
        material = bpy.data.materials.new(f'{body.name}.{kind}')
        material.diffuse_color = color
        material.use_nodes = True
        material.use_backface_culling = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value = color
        shader.inputs['Roughness'].default_value = roughness
        shader.inputs['Metallic'].default_value = metallic
        head.data.materials.append(material)
        return len(head.data.materials) - 1

    data = bmesh.new()
    data.from_mesh(head.data)
    layers = {layer.name: layer for layer in data.verts.layers.shape.values()}
    basis = layers['Basis']
    weights = data.verts.layers.deform.verify()
    # Which way a face of the pocket must look is told from the open mouth, where the pocket is not flat.
    wide = layers.get('mouth_open', basis)

    def face(corners, toward, color):
        """A face of the inside whose front looks toward a point, as the open mouth has it."""
        made = data.faces.new(corners)
        at = sum((corner[wide] for corner in corners), Vector()) / len(corners)
        normal = (corners[1][wide] - corners[0][wide]).cross(corners[2][wide] - corners[0][wide])
        if normal.dot(toward - at) < 0.0:
            made.normal_flip()
        made.material_index = color
        made.smooth = True

    # The human faces -Y: the front teeth's middle is where a mouth's hole is looked for.
    rim = _mouth_rim(data, to_head @ Vector((middle.x, low.y, middle.z)), half.x * 2.0)
    if rim is not None:
        dark = slot('mouth_dark')
        back = to_head.to_3x3() @ Vector((0.0, half.y * 1.75, 0.0))
        behind = [point[basis] + back for point in rim]
        center = sum(behind, Vector()) / len(behind)
        ring = []
        for point, place in zip(rim, behind):
            # The pocket narrows toward its back, away from the cheeks.
            new = data.verts.new(center + (place - center) * 0.8)
            for layer in layers.values():
                new[layer] = new.co + (point[layer] - point[basis])
            for index, weight in point[weights].items():
                new[weights][index] = weight
            ring.append(new)
        end = data.verts.new(center)
        for layer in layers.values():
            end[layer] = center + sum((point[layer] - point[basis] for point in rim), Vector()) / len(rim)
        for index, weight in rim[0][weights].items():
            end[weights][index] = weight
        axis = (sum((point[wide] for point in rim), Vector()) / len(rim) + end[wide]) / 2.0
        for index, point in enumerate(rim):
            after = (index + 1) % len(rim)
            face([point, rim[after], ring[after], ring[index]], axis, dark)
            face([end, ring[after], ring[index]], axis, dark)

    def row(teeth_row, name, root, share, show):
        """A row's points under a face shape, the row shortened toward its roots unless the shape opens the mouth:
        the rows overlap behind the lips, and a proxy's lips do not quite close, so whole rows would show as a
        white line in a shut mouth. As the mouth opens they come to their whole height, and the upper row a little
        below the upper lip's edge besides, where a speaking mouth shows its teeth."""
        if name == 'mouth_open':
            return [point + Vector((0.0, 0.0, show)) for point in teeth_row['points'][name]]
        return [Vector((before.x, before.y, root + (before.z - root) * share)) + (now - before)
                for now, before in zip(teeth_row['points'][name if name in teeth_row['points'] else 'Basis'], teeth_row['points']['Basis'])]

    def add(shapes, faces, color):
        """Vertices on the head's bone, each with its place under every face shape, and the faces between them."""
        points = [data.verts.new(to_head @ point) for point in shapes('Basis')]
        for name, layer in layers.items():
            for point, place in zip(points, shapes(name)):
                point[layer] = to_head @ place
        if group is not None:
            for point in points:
                point[weights][group] = 1.0
        for corners in faces:
            made = data.faces.new([points[index] for index in corners])
            made.material_index = color
            made.smooth = True

    if own_teeth:
        white = slot('mouth_white')
        height = high.z - low.z
        for teeth_row, root, share, show in ((upper, high.z, 0.8, -0.1 * height), (lower, low.z, 0.5, 0.0)):
            add(lambda name, at=(teeth_row, root, share, show): row(at[0], name, *at[1:]), teeth_row['faces'], white)
    if tongue is not None:
        # A tongue on the floor of the box of the base mesh's own, three quarters as high: it lies flat in a
        # shut mouth, under the pocket's floor, rises to its height as the mouth opens, and goes with the lower teeth.
        floor, top = tongue
        ball, ball_faces = _ball(8, 4)
        size = (top - floor) / 2.0
        whole = [Vector((floor.x + size.x * (1.0 + point.x), floor.y + size.y * (1.15 + point.y * 0.85), floor.z + size.z * 0.75 * (1.0 + point.z)))
                 for point in ball]

        def tongue_shapes(name):
            known = name if name in lower['points'] else 'Basis'
            jaw = sum((now - before for now, before in zip(lower['points'][known], lower['points']['Basis'])), Vector()) / len(lower['points']['Basis'])
            share = 1.0 if name == 'mouth_open' else 0.3
            return [Vector((point.x, point.y, floor.z + (point.z - floor.z) * share)) + jaw for point in whole]

        add(tongue_shapes, ball_faces, slot('mouth_pink'))
    data.to_mesh(head.data)
    data.free()
    head.data.update()
    return len(head.data.vertices) - before


def _apply_masks(mesh):
    """Delete what a mesh's Mask modifiers hide, and remove them, without losing its shape keys."""
    import bmesh
    masks = [modifier for modifier in mesh.modifiers
             if modifier.type == 'MASK' and modifier.mode == 'VERTEX_GROUP' and modifier.vertex_group in mesh.vertex_groups]
    if not masks:
        return
    hidden = set()
    for mask in masks:
        group = mesh.vertex_groups[mask.vertex_group].index
        inside = {vertex.index for vertex in mesh.data.vertices
                  if any(entry.group == group and entry.weight > mask.threshold for entry in vertex.groups)}
        hidden |= inside if mask.invert_vertex_group else set(range(len(mesh.data.vertices))) - inside
    data = bmesh.new()
    data.from_mesh(mesh.data)
    data.verts.ensure_lookup_table()
    bmesh.ops.delete(data, geom=[data.verts[index] for index in hidden], context='VERTS')
    data.to_mesh(mesh.data)
    data.free()
    for mask in masks:
        mesh.modifiers.remove(mask)


def _add_eye_bones(services, body):
    """Add the bones eye_l and eye_r under the head and hang each eyeball on its own, so that a game can turn the eyes."""
    from mathutils import Vector
    rig = body.parent if body.parent is not None and body.parent.type == 'ARMATURE' else None
    eyes = _fitted(services, body, ('Eyes',))
    head = next((name for name in ('head', 'Head', 'mixamorig:Head') if rig is not None and name in rig.data.bones), None)
    if not eyes or head is None:
        return []
    # The character's left side is +X: it faces -Y.
    centers = {}
    for side, sign in (('l', 1.0), ('r', -1.0)):
        points = [eye.matrix_world @ vertex.co for eye in eyes for vertex in eye.data.vertices]
        points = [point for point in points if point.x * sign > 0.0]
        if not points:
            return []
        # An eye turns about its ball's middle: about any other point it would slide in its socket as it turns, into
        # the lid on one side and away from it on the other.
        centers[side] = Vector(_fit_ball([point[:] for point in points])[0])
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    to_rig = rig.matrix_world.inverted()
    for side, center in centers.items():
        bone = rig.data.edit_bones.get('eye_' + side) or rig.data.edit_bones.new('eye_' + side)
        bone.head = to_rig @ center
        # The bone points out of the face, the way the eye looks.
        bone.tail = to_rig @ (center + Vector((0.0, -0.03, 0.0)))
        bone.roll = 0.0
        bone.parent = rig.data.edit_bones[head]
        bone.use_deform = True
    bpy.ops.object.mode_set(mode='OBJECT')
    for eye in eyes:
        sides = {'l': [], 'r': []}
        for vertex in eye.data.vertices:
            sides['l' if (eye.matrix_world @ vertex.co).x > 0.0 else 'r'].append(vertex.index)
        for group in list(eye.vertex_groups):
            eye.vertex_groups.remove(group)
        for side, indices in sides.items():
            eye.vertex_groups.new(name='eye_' + side).add(indices, 1.0, 'REPLACE')
    return ['eye_l', 'eye_r']
