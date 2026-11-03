def greeting(name):
    print(f"嘿，{name}！")


if __name__ == "__main__":
    import sys

    name = sys.argv[1] if len(sys.argv) > 1 else "朋友"
    greeting(name)
