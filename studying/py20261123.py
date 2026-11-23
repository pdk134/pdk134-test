import multiprocessing as mp

def w1(v:mp.Value):
    for i in range(10000):
        v.value += 1

def w2(v:mp.Value):
    for i in range(10000):
        v.value += 1

if __name__ == '__main__':
    v = mp.Value('i', 0)
    p1 = mp.Process(target=w1, args=(v,))
    p2 = mp.Process(target=w2, args=(v,))
    p1.start()
    p2.start()
    p1.join()
    p2.join()
    print(v.value)
